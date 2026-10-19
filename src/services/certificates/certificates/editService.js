import crypto from "crypto";
import JSZip from "jszip";
import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import * as renderer from "../engine/renderer.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { renderFilled, fillDef } from "../templates/prepareEngine.js";
import { resolveField } from "../generation/valueResolver.js";
import { loadDesign, certificateContext, countBlocking, isBlocking, loadBatch } from "../generation/batchService.js";
import { loadCertificate } from "./certificateService.js";

// Edit, versions, export, finalize (CERTIFICATES_V2_PLAN.md §11). Every
// change is a NEW CertificateVersion (edits never overwrite, D8); concurrency
// is optimistic on Certificate.currentVersion; a final certificate is frozen.
// Every HTML/PDF comes from a server render (D11).

const THUMB_SCALE = 0.25;
const MAX_VALUE = 2000;
const COMPANY_SELECT = { id: true, name: true, address: true, phone: true, email: true };

function assertEditable(cert) {
  if (cert.status === "final") throw new CertError("CERTIFICATE_FINAL", "This certificate is final. Duplicate it as a draft to change it.", 409);
  if (cert.status !== "draft") throw new CertError("CERTIFICATE_NOT_READY", `This certificate is ${cert.status} and cannot be edited`, 409);
}

// review #8: required on every change (edit, reset, restore, finalize) — a
// change made on a version the user never saw is refused, not applied
function assertVersion(cert, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) {
    throw new CertError("VERSION_REQUIRED", `expectedVersion is required (the current version is ${cert.currentVersion})`, 400, { currentVersion: cert.currentVersion });
  }
  if (Number(expectedVersion) !== cert.currentVersion) {
    throw new CertError("VERSION_CONFLICT", `The certificate changed meanwhile (now version ${cert.currentVersion})`, 409, { currentVersion: cert.currentVersion });
  }
}

async function currentVersionRow(cert) {
  const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: cert.id, versionNumber: cert.currentVersion } } });
  if (!v) throw notFound("Certificate version");
  return v;
}

const short = (s) => {
  const t = String(s ?? "");
  return t.length > 40 ? `${t.slice(0, 37)}…` : t || "∅";
};

/** values → re-rendered static HTML + thumbnail, flags merged (resolver flags kept only for auto values). */
async function renderValues(cert, values) {
  const design = await loadDesign(new Map(), cert.templateVersionId);
  const out = await renderFilled(
    design.html,
    design.fields.map(fillDef),
    Object.fromEntries(design.fields.map((f) => [f.key, values[f.key]?.value ?? ""])),
    { fontCoverage: design.version.fontCoverage, label: "certificate", thumbnailScale: THUMB_SCALE }
  );
  const merged = {};
  for (const f of design.fields) {
    const v = values[f.key] || { value: "", source: f.source, resolved: "", origin: "auto", editedByUserId: null, editedAt: null };
    const kept = v.origin === "manual" ? [] : (v.flags || []).filter((x) => x === "format");
    merged[f.key] = { ...v, flags: [...new Set([...kept, ...(out.flags[f.key] || [])])] };
  }
  return { values: merged, html: out.html, thumbnail: out.thumbnail };
}

/**
 * Stores version N+1 — only if the certificate is still a draft at version N
 * (optimistic concurrency). files: { htmlFileId, thumbnailFileId } to reuse,
 * or { html, thumbnail } to store.
 */
async function commitVersion(cert, values, { changeSource, userId, summary, files }) {
  const htmlFileId = files.htmlFileId ?? (await fileStore.putFile({ companyId: cert.companyId, kind: "certificate_html", buffer: Buffer.from(files.html, "utf8"), mimeType: "text/html" })).id;
  const thumbnailFileId =
    files.thumbnailFileId !== undefined ? files.thumbnailFileId : files.thumbnail ? (await fileStore.putFile({ companyId: cert.companyId, kind: "certificate_thumb", buffer: files.thumbnail, mimeType: "image/png" })).id : null;
  const next = cert.currentVersion + 1;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.certificate.updateMany({
      where: { id: cert.id, status: "draft", currentVersion: cert.currentVersion },
      data: { currentVersion: next, flagCount: countBlocking(values) },
    });
    if (!claimed.count) {
      const now = await tx.certificate.findUnique({ where: { id: cert.id }, select: { currentVersion: true, status: true } });
      if (now?.status === "final") throw new CertError("CERTIFICATE_FINAL", "This certificate was finalized meanwhile", 409);
      throw new CertError("VERSION_CONFLICT", `The certificate changed meanwhile (now version ${now?.currentVersion})`, 409, { currentVersion: now?.currentVersion });
    }
    const version = await tx.certificateVersion.create({
      data: { certificateId: cert.id, versionNumber: next, values, htmlFileId, thumbnailFileId, changeSource, changedByUserId: userId || null, changeSummary: summary ? summary.slice(0, 500) : null },
    });
    return { version: next, values, flags: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.flags])), flagCount: countBlocking(values), changeSummary: version.changeSummary };
  });
}

/** PATCH /certificates/:id/values — { expectedVersion, changes: { key: value } } */
export async function editValues(id, companyId, userId, { expectedVersion, changes = {} }) {
  const cert = await loadCertificate(id, companyId);
  assertEditable(cert);
  assertVersion(cert, expectedVersion);
  const current = await currentVersionRow(cert);
  const values = structuredClone(current.values || {});
  const now = new Date().toISOString();
  const summary = [];
  for (const [key, raw] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new CertError("UNKNOWN_FIELD", `"${key}" is not a field of this certificate`, 422, { field: key });
    const value = raw === null || raw === undefined ? "" : String(raw);
    if (value.length > MAX_VALUE) throw new CertError("VALUE_TOO_LONG", `"${key}" is longer than ${MAX_VALUE} characters`, 422, { field: key });
    if (value === values[key].value) continue;
    summary.push(`${key}: ${short(values[key].value)} → ${short(value)}`);
    values[key] = { ...values[key], value, origin: "manual", editedByUserId: userId || null, editedAt: now };
  }
  if (!summary.length) return { version: cert.currentVersion, values: current.values, flags: Object.fromEntries(Object.entries(current.values || {}).map(([k, v]) => [k, v.flags])), flagCount: cert.flagCount, unchanged: true };
  const r = await renderValues(cert, values);
  return commitVersion(cert, r.values, { changeSource: "user_edit", userId, summary: summary.join("; "), files: { html: r.html, thumbnail: r.thumbnail } });
}

async function resolverContext(cert) {
  const full = await prisma.certificate.findUnique({ where: { id: cert.id }, include: { items: { orderBy: { position: "asc" }, include: { invoiceItem: true } }, invoice: true } });
  const [company, invoiceBrand] = await Promise.all([
    prisma.company.findUnique({ where: { id: cert.companyId }, select: COMPANY_SELECT }),
    full.invoice.brandId ? prisma.brand.findUnique({ where: { id: full.invoice.brandId }, select: { id: true, name: true } }) : null,
  ]);
  const design = await loadDesign(new Map(), cert.templateVersionId);
  const ctx = await certificateContext(full, { invoice: full.invoice, company, invoiceBrand, today: new Date() }, { products: new Map() }, design);
  return { design, ctx };
}

/** POST /certificates/:id/fields/:key/reset — re-resolve one field from its declared source. */
export async function resetField(id, companyId, userId, key, { expectedVersion } = {}) {
  const cert = await loadCertificate(id, companyId);
  assertEditable(cert);
  assertVersion(cert, expectedVersion);
  const current = await currentVersionRow(cert);
  const { design, ctx } = await resolverContext(cert);
  const field = design.fields.find((f) => f.key === key);
  if (!field || !Object.prototype.hasOwnProperty.call(current.values || {}, key)) throw notFound("Field");
  const r = resolveField(field, ctx);
  const values = structuredClone(current.values);
  values[key] = { value: r.value, source: field.source, resolved: r.resolved, origin: "auto", flags: r.flags, editedByUserId: null, editedAt: null };
  const rendered = await renderValues(cert, values);
  return commitVersion(cert, rendered.values, {
    changeSource: "regenerate_field",
    userId,
    summary: `${key} reset to source value (${short(current.values[key].value)} → ${short(r.value)})`,
    files: { html: rendered.html, thumbnail: rendered.thumbnail },
  });
}

/** GET /certificates/:id/versions */
export async function listVersions(id, companyId) {
  await loadCertificate(id, companyId);
  const rows = await prisma.certificateVersion.findMany({ where: { certificateId: id }, orderBy: { versionNumber: "desc" } });
  const userIds = [...new Set(rows.map((r) => r.changedByUserId).filter(Boolean))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  return rows.map((r) => ({
    versionNumber: r.versionNumber,
    changeSource: r.changeSource,
    changeSummary: r.changeSummary,
    changedByUserId: r.changedByUserId,
    changedBy: r.changedByUserId ? nameOf.get(r.changedByUserId) || null : null,
    createdAt: r.createdAt,
    hasPdf: !!r.pdfFileId,
    flagCount: countBlocking(r.values),
  }));
}

/** POST /certificates/:id/versions/:n/restore — forward-only: version n's values become N+1. */
export async function restoreVersion(id, companyId, userId, n, { expectedVersion } = {}) {
  const cert = await loadCertificate(id, companyId);
  assertEditable(cert);
  assertVersion(cert, expectedVersion);
  if (Number(n) === cert.currentVersion) throw new CertError("ALREADY_CURRENT", `Version ${n} is already the current version`, 409);
  const old = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: id, versionNumber: Number(n) } } });
  if (!old) throw notFound("Certificate version");
  const current = await currentVersionRow(cert);
  const values = structuredClone(old.values);
  for (const [k, v] of Object.entries(values)) if (current.values?.[k]?.value !== v.value) values[k] = { ...v, origin: "restored" };
  // the same template version + the same values = the same document: reuse v{n}'s render
  return commitVersion(cert, values, { changeSource: "restore", userId, summary: `restored version ${n}`, files: { htmlFileId: old.htmlFileId, thumbnailFileId: old.thumbnailFileId } });
}

// ── PDF ──────────────────────────────────────────────────────────────────────
const safe = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);

async function pdfName(certId) {
  const c = await prisma.certificate.findUnique({
    where: { id: certId },
    include: { certificateType: { select: { code: true } }, product: { select: { name: true } }, invoice: { select: { header: true } }, items: { orderBy: { position: "asc" }, take: 1, include: { invoiceItem: { select: { data: true } } } } },
  });
  const what = c.scope === "per_invoice" ? "invoice" : c.product?.name;
  const ref = c.scope === "per_invoice" ? c.invoice?.header?.invoiceNumber : c.items[0]?.invoiceItem?.data?.batchNo;
  return `${[safe(c.certificateType?.code), safe(what), safe(ref)].filter(Boolean).join("-") || "certificate"}.pdf`;
}

/** Makes sure version `n` of a certificate has a PDF → pdfFileId (idempotent). */
export async function ensureVersionPdf(cert, versionNumber = cert.currentVersion) {
  const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: cert.id, versionNumber } } });
  if (!v) throw notFound("Certificate version");
  if (v.pdfFileId) return v.pdfFileId;
  if (!v.htmlFileId) throw new CertError("NO_HTML", "This version has no rendered document", 409);
  const html = await fileStore.readText(v.htmlFileId);
  const { pdf } = await renderer.printPdf(html);
  const row = await fileStore.putFile({ companyId: cert.companyId, kind: "certificate_pdf", buffer: pdf, mimeType: "application/pdf" });
  await prisma.certificateVersion.update({ where: { id: v.id }, data: { pdfFileId: row.id } });
  return row.id;
}

/** POST /certificates/:id/export-pdf → 202 { taskId } (the job renders the current version's PDF). */
export async function startExportPdf(id, companyId) {
  const cert = await loadCertificate(id, companyId);
  if (!["draft", "final"].includes(cert.status)) throw new CertError("CERTIFICATE_NOT_READY", `This certificate is ${cert.status}`, 409);
  const task = await enqueueTask({
    queueName: QUEUES.render,
    jobName: "exportPdf",
    type: "certificate_export_pdf",
    companyId: cert.companyId,
    data: { entity: "certificate", entityId: id, certificateId: id, versionNumber: cert.currentVersion },
  });
  return { certificateId: id, versionNumber: cert.currentVersion, taskId: task.id };
}

/** The `exportPdf` job. */
export async function runExportPdf({ certificateId, versionNumber }) {
  const cert = await prisma.certificate.findUnique({ where: { id: certificateId } });
  if (!cert) throw notFound("Certificate");
  const pdfFileId = cert.status === "final" && cert.finalPdfFileId ? cert.finalPdfFileId : await ensureVersionPdf(cert, versionNumber || cert.currentVersion);
  return { certificateId, versionNumber: versionNumber || cert.currentVersion, pdfFileId };
}

/** GET /certificates/:id/pdf[?version=n] — the frozen PDF of a final certificate, else the exported one. */
export async function getPdf(id, companyId, version = null) {
  const cert = await loadCertificate(id, companyId);
  let fileId = null;
  if (!version && cert.status === "final") fileId = cert.finalPdfFileId;
  else {
    const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: id, versionNumber: Number(version || cert.currentVersion) } } });
    if (!v) throw notFound("Certificate version");
    fileId = v.pdfFileId;
  }
  if (!fileId) throw new CertError("PDF_NOT_EXPORTED", "Export the PDF first", 404);
  const { row, buffer } = await fileStore.readFile(fileId, { companyId: cert.companyId });
  return { row, buffer, fileName: await pdfName(id) };
}

// ── finalize / duplicate ─────────────────────────────────────────────────────
/** POST /certificates/:id/finalize — refuses while blocking flags remain; freezes the PDF. */
export async function finalize(id, companyId, userId, { expectedVersion } = {}) {
  const cert = await loadCertificate(id, companyId);
  assertEditable(cert);
  assertVersion(cert, expectedVersion);
  if (cert.flagCount > 0) {
    const v = await currentVersionRow(cert);
    const flags = Object.fromEntries(Object.entries(v.values || {}).map(([k, x]) => [k, (x.flags || []).filter(isBlocking)]).filter(([, f]) => f.length));
    throw new CertError("CERTIFICATE_FLAGGED", `Fix ${cert.flagCount} issue${cert.flagCount === 1 ? "" : "s"} before finalizing: ${Object.keys(flags).join(", ")}`, 409, { flags });
  }
  const pdfFileId = await ensureVersionPdf(cert);
  const done = await prisma.certificate.updateMany({
    where: { id, status: "draft", currentVersion: cert.currentVersion, flagCount: 0 },
    data: { status: "final", finalizedAt: new Date(), finalizedByUserId: userId || null, finalPdfFileId: pdfFileId },
  });
  if (!done.count) throw new CertError("VERSION_CONFLICT", "The certificate changed meanwhile — reload and try again", 409);
  return prisma.certificate.findUnique({ where: { id } });
}

/** POST /certificates/:id/duplicate — a new draft with the current values (the way to change a final certificate). */
export async function duplicate(id, companyId, userId) {
  const cert = await loadCertificate(id, companyId);
  if (!["draft", "final"].includes(cert.status)) throw new CertError("CERTIFICATE_NOT_READY", `This certificate is ${cert.status}`, 409);
  const v = await currentVersionRow(cert);
  const items = await prisma.certificateItem.findMany({ where: { certificateId: id } });
  return prisma.$transaction(async (tx) => {
    const copy = await tx.certificate.create({
      data: {
        companyId: cert.companyId,
        batchId: cert.batchId,
        invoiceId: cert.invoiceId,
        templateVersionId: cert.templateVersionId,
        certificateTypeId: cert.certificateTypeId,
        scope: cert.scope,
        productId: cert.productId,
        planKey: `${cert.planKey}#copy-${crypto.randomUUID().slice(0, 8)}`,
        status: "draft",
        currentVersion: 1,
        flagCount: cert.flagCount,
        search: cert.search,
      },
    });
    await tx.certificateItem.createMany({ data: items.map((i) => ({ certificateId: copy.id, invoiceItemId: i.invoiceItemId, position: i.position })) });
    await tx.certificateVersion.create({
      data: {
        certificateId: copy.id,
        versionNumber: 1,
        values: v.values,
        htmlFileId: v.htmlFileId,
        thumbnailFileId: v.thumbnailFileId,
        changeSource: "duplicate",
        changedByUserId: userId || null,
        changeSummary: `duplicated from version ${v.versionNumber} of certificate ${id}`,
      },
    });
    return { certificateId: copy.id, duplicatedFrom: id };
  });
}

// ── batch ZIP ────────────────────────────────────────────────────────────────
/** POST /certificate-batches/:id/export → 202 { taskId } */
export async function startExportZip(batchId, companyId) {
  const batch = await loadBatch(batchId, companyId);
  if (["queued", "running"].includes(batch.status)) throw new CertError("BATCH_RUNNING", "Wait for the batch to finish", 409);
  const task = await enqueueTask({ queueName: QUEUES.render, jobName: "exportZip", type: "certificate_export_zip", companyId: batch.companyId, data: { entity: "certificate_batch", entityId: batchId, batchId } });
  return { batchId, taskId: task.id };
}

/** The `exportZip` job: one PDF per rendered certificate (final → its frozen PDF), unique names. */
export async function runExportZip({ batchId }, ctx = {}) {
  const batch = await prisma.certificateBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw notFound("Certificate batch");
  const certs = await prisma.certificate.findMany({ where: { batchId, status: { in: ["draft", "final"] } }, orderBy: [{ createdAt: "asc" }, { planKey: "asc" }] });
  if (!certs.length) throw new CertError("NOTHING_TO_EXPORT", "This batch has no rendered certificates", 409);
  const zip = new JSZip();
  const used = new Set();
  for (const [i, c] of certs.entries()) {
    const fileId = c.status === "final" && c.finalPdfFileId ? c.finalPdfFileId : await ensureVersionPdf(c);
    const { buffer } = await fileStore.readFile(fileId);
    let name = await pdfName(c.id);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/(-\d+)?\.pdf$/, `-${n}.pdf`);
    used.add(name.toLowerCase());
    zip.file(name, buffer);
    ctx.progress?.(Math.round((90 * (i + 1)) / certs.length), `${i + 1} of ${certs.length}`);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const row = await fileStore.putFile({ companyId: batch.companyId, kind: "batch_zip", buffer, mimeType: "application/zip" });
  await prisma.certificateBatch.update({ where: { id: batchId }, data: { zipFileId: row.id } });
  return { batchId, zipFileId: row.id, files: certs.length };
}

/** GET /certificate-batches/:id/zip */
export async function getZip(batchId, companyId) {
  const batch = await loadBatch(batchId, companyId);
  if (!batch.zipFileId) throw new CertError("ZIP_NOT_EXPORTED", "Export the batch first", 404);
  const { row, buffer } = await fileStore.readFile(batch.zipFileId, { companyId: batch.companyId });
  const inv = await prisma.invoice.findUnique({ where: { id: batch.invoiceId }, select: { header: true } });
  return { row, buffer, fileName: `certificates-${safe(inv?.header?.invoiceNumber) || batchId.slice(0, 8)}.zip` };
}
