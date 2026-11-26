import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { loadInvoice } from "../invoices/invoiceService.js";
import { listFields, listGroups } from "../templates/fieldService.js";
import { renderFilled, fillDef, groupFillDef } from "../templates/prepareEngine.js";
import { computePlan, previewPlan as planPreview } from "./planService.js";
import { resolveField, resolveGroups, applyFormat } from "./valueResolver.js";
import { refreshIfChecked, blockingCounts, usableNeeds, AWAITING } from "../dataNeeds/dataNeedsService.js";
import { getDictionary, pathSynonymMap } from "../dictionary/dataDictionary.js";
import { maskEstimates, provenanceFor } from "../../catalogues/fieldProvenance.js";
import { assertVersionsReady } from "../templates/readinessService.js";
import { isProtected } from "../inference/policy.js";
import { allocateDocNumber } from "./docNumbers.js";

// Generation (CERTIFICATES_V2_PLAN.md §10): invoice (ready) → frozen plan →
// CertificateBatch + Certificate/CertificateItem rows in ONE transaction →
// `generateBatch` job renders version 1 of each certificate. One certificate
// failing never stops the batch. Values come only from declared sources (D7):
// an empty required value renders empty and is flagged `missing`, an empty optional one `empty_optional`.

export const GENERATABLE = ["ready", "generated", "partially_failed"];
const PREVIEWABLE = ["review", ...GENERATABLE];
const RENDER_CONCURRENCY = 2; // pages per worker process (§5.2)
const THUMB_SCALE = 0.25;
const COMPANY_SELECT = { id: true, name: true, address: true, phone: true, email: true, profile: true };

/** Flags that block finalisation (§10.4): a required value missing, overflow, a character no available font has,
 *  an estimate nobody confirmed yet (`unconfirmed`: printed on the draft, never on a final certificate).
 *  Informational: `estimated` (28 Nov: a descriptive value the AI estimated — printed, marked «مستنتج», never blocking), `glyph_fallback:…` (drawn in the matched fallback font), `glyph_unknown` (the font couldn't be parsed,
 *  review #7) and `empty_optional` (an optional value the pipeline couldn't fill). */
export const isBlocking = (flag) => flag === "missing" || flag === "sample_value" || String(flag).startsWith("rows_overflow") || flag === "overflow" || flag === "missing_span" || flag === "unconfirmed" || String(flag).startsWith("glyph:");
/** Never blank silently (owner, 2026-11-05): an optional field left empty says so, unless the owner marked it not applicable. */
export const emptyFlags = (field, value) => (value || field.required || field.notApplicable ? [] : ["empty_optional"]);
export const countBlocking = (values) => Object.values(values || {}).filter((v) => (v.flags || []).some(isBlocking)).length;

/** GET /invoices/:id/generation-plan — what "Generate" would produce (plan §13.5, §20 I19). */
export async function previewPlan(invoiceId, companyId) {
  const invoice = await loadInvoice(invoiceId, companyId);
  if (!PREVIEWABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `There is nothing to plan for an invoice that is ${invoice.status}`, 409);
  return planPreview(invoice);
}

const searchText = (parts) =>
  parts
    .filter(Boolean)
    .map((s) => String(s).trim())
    .join(" ")
    .toLowerCase() || null;

/**
 * The generate gate (plan.md §6.2): for an invoice whose data check has run,
 * refresh it by code and refuse while required values are missing or waiting
 * for confirmation — unless `force` with `canForce`. → { gated, open? }
 */
export async function assertDataCheckGate(invoice, { force = false, canForce = false } = {}) {
  if (!(await refreshIfChecked(invoice))) return { gated: false };
  const open = await blockingCounts(invoice.id);
  if (open.missing + open.needsConfirmation > 0) {
    if (!force) throw new CertError("DATA_NEEDS_OPEN", `${open.missing} required value(s) missing and ${open.needsConfirmation} waiting for confirmation — complete the certificate data check first`, 409, open);
    if (!canForce) throw new CertError("FORBIDDEN", "Generating with open values needs the update_certificates permission", 403);
  }
  return { gated: true, open };
}

/**
 * POST /invoices/:id/generate → 202 { batchId, taskId, planned }
 * The certificate data check (plan.md §6.2): once it has been run for the
 * invoice, required values that are still missing or awaiting confirmation
 * block generation — unless `force` ("Generate anyway (leave empty, flagged)",
 * which needs update_certificates: `canForce`; an estimate still prints, flagged). Never run → V2 behaviour (D7:
 * empty required values render flagged).
 */
export async function startGeneration(invoiceId, companyId, userId, { force = false, canForce = false, only = null } = {}) {
  const invoice = await loadInvoice(invoiceId, companyId);
  if (!GENERATABLE.includes(invoice.status)) {
    throw new CertError("INVOICE_NOT_READY", `Confirm the invoice before generating (it is ${invoice.status})`, 409);
  }
  await assertDataCheckGate(invoice, { force, canForce });
  const plan = await computePlan(invoice);
  // only (28 Nov, a request a second drop added to): just the new cells — the new lines, and every line
  // for a newly asked type; the drafts already made (and answered) are left as they are
  if (only) {
    const lines = new Set(only.itemIds || []);
    const codes = new Set((only.codes || []).map((c) => String(c).toUpperCase()));
    const typeCodes = codes.size ? new Map((await prisma.certificateType.findMany({ where: { companyId: invoice.companyId }, select: { id: true, code: true } })).map((t) => [t.id, t.code])) : new Map();
    plan.entries = plan.entries.filter((e) => e.invoiceItemIds.some((i) => lines.has(i)) || codes.has(typeCodes.get(e.certificateTypeId)));
  }
  if (!plan.entries.length) {
    throw new CertError("NOTHING_TO_GENERATE", "No active template applies to any line of this invoice", 409, { unassigned: plan.unassigned, gaps: plan.gaps });
  }
  // every path (invoice, product, chat, Express, Make certificates) comes here: a template with
  // unmarked batch / date / result text is refused, never printed with its sample's values
  await assertVersionsReady(plan.entries.map((e) => e.templateVersionId));
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId }, include: { product: { select: { name: true } } } });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const invoiceNo = invoice.header?.invoiceNumber || null;

  const batch = await prisma.$transaction(async (tx) => {
    // claim the invoice: two concurrent "Generate" clicks never make two batches
    const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, status: { in: GENERATABLE } }, data: { status: "generating" } });
    if (!claimed.count) throw new CertError("INVOICE_NOT_READY", "This invoice is already being generated", 409);
    const b = await tx.certificateBatch.create({
      data: { companyId: invoice.companyId, invoiceId, status: "queued", plan, counts: { planned: plan.entries.length, rendered: 0, failed: 0, flagged: 0 }, startedByUserId: userId || null },
    });
    for (const e of plan.entries) {
      const first = itemById.get(e.invoiceItemIds[0]);
      const cert = await tx.certificate.create({
        data: {
          companyId: invoice.companyId,
          batchId: b.id,
          invoiceId,
          templateVersionId: e.templateVersionId,
          certificateTypeId: e.certificateTypeId,
          scope: e.scope,
          productId: e.productId,
          planKey: e.planKey,
          status: "pending",
          search: e.scope === "per_invoice" ? searchText([e.typeCode, invoiceNo, invoice.header?.customerName]) : searchText([first?.product?.name, first?.data?.batchNo, invoiceNo]),
        },
      });
      await tx.certificateItem.createMany({ data: e.invoiceItemIds.map((invoiceItemId, position) => ({ certificateId: cert.id, invoiceItemId, position })) });
    }
    return b;
  });

  try {
    const task = await enqueueTask({
      queueName: QUEUES.render,
      jobName: "generateBatch",
      type: "certificate_generate_batch",
      companyId: invoice.companyId,
      data: { entity: "certificate_batch", entityId: batch.id, batchId: batch.id },
    });
    return { batchId: batch.id, taskId: task.id, planned: plan.entries.length, unassigned: plan.unassigned.length };
  } catch (err) {
    await finishBatch(batch.id, `Could not queue generation: ${err.message}`);
    throw err;
  }
}

// ── the generateBatch job ────────────────────────────────────────────────────
export async function loadDesign(cache, templateVersionId) {
  if (!cache.has(templateVersionId)) {
    cache.set(
      templateVersionId,
      (async () => {
        const v = await prisma.templateVersion.findUnique({ where: { id: templateVersionId }, include: { template: { include: { brand: { select: { id: true, name: true } } } } } });
        if (!v?.preparedFileId) throw new CertError("NOT_PREPARED", `Template version ${templateVersionId} has no prepared design`, 409);
        const [html, fields, groups] = await Promise.all([fileStore.readText(v.preparedFileId), listFields(v.id), listGroups(v.id)]);
        return { version: v, html, fields, groups };
      })()
    );
  }
  return cache.get(templateVersionId);
}

/** A design's plain fields (group cells excluded). */
export const plainFields = (design) => design.fields.filter((f) => !f.groupKey);

/**
 * Renders `values` (CertificateVersion.values shape) with a design → { html, flags, geometry, thumbnail }.
 * values[groupKey].rows are the group's rows (§7.8).
 */
export function renderDesign(design, values, { label, thumbnailScale = null } = {}) {
  const fields = plainFields(design);
  const groups = (design.groups || []).filter((g) => g.geometry).map((g) => groupFillDef(g, design.fields));
  const flat = Object.fromEntries(fields.map((f) => [f.key, values[f.key]?.value ?? ""]));
  for (const g of design.groups || []) flat[g.key] = values[g.key]?.rows ?? [];
  return renderFilled(design.html, fields.map(fillDef), flat, { fontCoverage: design.version.fontCoverage, fontFallbacks: design.version.fontFallbacks, label, thumbnailScale, groups });
}

/** A stored group value (§10.4). */
export const groupValue = (g, resolved, out, extra = {}) => ({
  kind: "group",
  rows: resolved.rows,
  resolvedRows: resolved.resolvedRows ?? resolved.rows,
  source: g.source,
  origin: "auto",
  flags: [...new Set([...(resolved.flags || []), ...(out.flags[g.key] || [])])],
  rowsFit: out.geometry?.[g.key]?.rowsFit ?? null,
  editedByUserId: null,
  editedAt: null,
  ...extra,
});

async function loadProductCtx(cache, companyId, productId) {
  if (!productId) return null;
  if (!cache.has(productId)) {
    cache.set(
      productId,
      prisma.product
        .findFirst({ where: { id: productId, companyId }, include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } })
        // an unconfirmed estimated value is never printed until a person signed for it (A6) — the data check offers it for confirmation
        .then(maskEstimates)
    );
  }
  return cache.get(productId);
}

/**
 * Resolver context for one certificate (§10.3):
 *  per_product — its invoice line, the matched product (+ brand), invoice header, company;
 *  per_invoice — invoice header, company and the template's brand (else the invoice's); item/product
 *                sources stay empty; a repeating group reads the lines (Phase 7).
 *  lines — every invoice line of the certificate, in order, each with its matched product
 *          (tenant-scoped) as `product`: the rows of an `invoice_lines` group (§7.8).
 */
export async function certificateContext(cert, base, caches, design) {
  const ctx = { invoice: base.invoice.header || {}, company: base.company, today: base.today, ...(base.pathSynonyms ? { pathSynonyms: base.pathSynonyms } : {}) };
  ctx.lines = [];
  for (const ci of cert.items || []) {
    const line = ci.invoiceItem;
    if (!line) continue;
    const product = line.productId ? await loadProductCtx(caches.products, cert.companyId, line.productId) : null;
    ctx.lines.push({ ...(line.data || {}), product: product || {} });
  }
  if (cert.scope === "per_product") {
    const line = cert.items[0]?.invoiceItem;
    ctx.item = { ...(line?.data || {}), lineNo: line?.lineNo ?? null };
    const product = await loadProductCtx(caches.products, cert.companyId, cert.productId);
    if (product) {
      ctx.product = product;
      ctx.brand = product.brand || null;
    }
  } else {
    ctx.brand = design.version.template.brand || base.invoiceBrand || null;
  }
  return ctx;
}

/**
 * One plain field's value (plan.md §4 "Generation"): what the certificate data
 * check settled (provided / resolved_ai) first, so what the user confirmed is
 * exactly what is rendered; else its declared source (with accepted synonyms).
 * → { value, resolved, flags, origin: data_check|auto, provenance? }
 */
/**
 * The design's own sample text on a batch fact / lab result (26 Nov: CALCIUT printed DOXYPHARMA's
 * batch): a fixed text there, or a value identical to what the template file printed, is never
 * printed — blank and flagged `sample_value` (blocking). A value a person settled (the data check)
 * or typed is theirs and stays.
 */
export function guardSample(field, r) {
  if (!r.value || !isProtected(field)) return r;
  const same = String(r.value).trim().toLowerCase() === String(field.sampleValue || "").trim().toLowerCase();
  if (field.source?.kind !== "static" && !same) return r;
  return { ...r, value: "", resolved: "", flags: [...new Set([...(r.flags || []).filter((f) => f !== "empty_optional"), "sample_value", ...(field.required ? ["missing"] : [])])], blockedSample: r.value };
}

export function resolveWithNeed(field, ctx, need) {
  if (need && need.value !== null && need.value !== undefined) {
    const { value, flags } = applyFormat(need.value, field.format);
    // who confirmed it travels with the value (plan.md §14.4: the tier, evidence and the person, forever)
    return { value, resolved: need.value, flags: [...(flags || []), ...(AWAITING.includes(need.status) ? ["unconfirmed"] : [])], origin: "data_check", provenance: { ...(need.provenance || {}), needId: need.id, needStatus: need.status, confirmedByUserId: need.decidedByUserId ?? null, confirmedAt: need.decidedAt ?? null } };
  }
  const r = resolveField(field, ctx);
  const out = { value: r.value, resolved: r.resolved, flags: [...(r.flags || []), ...emptyFlags(field, r.value)], origin: "auto", ...(r.via ? { provenance: { kind: "path", path: r.via, via: "synonym" } } : {}) };
  // 28 Nov: where a product value came from travels with it — a file (the source chip: file, page,
  // quote) or an estimate (the «مستنتج» chip: basis, reasoning; flag `estimated`, never blocking)
  const pv = r.value && field.source?.kind === "product" && !r.via ? provenanceFor(ctx.product, field.source.path) : null;
  if (pv) {
    const { path: _p, ...rest } = pv;
    out.provenance = { kind: "product", path: field.source.path, ...rest };
    if (pv.estimated === true && !pv.confirmedAt) out.flags = [...out.flags, "estimated"];
  }
  return guardSample(field, out);
}

/** Renders version 1 of one certificate. Idempotent: a certificate that already has v1 is left alone. */
export async function renderInitialVersion(cert, base, caches) {
  if (await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: cert.id, versionNumber: 1 } }, select: { id: true } })) {
    return prisma.certificate.update({ where: { id: cert.id }, data: { status: "draft", currentVersion: { set: Math.max(cert.currentVersion, 1) }, error: null } });
  }
  const design = await loadDesign(caches.designs, cert.templateVersionId);
  const ctx = await certificateContext(cert, base, caches, design);
  const needs = base.needs?.get(cert.planKey);
  // its own document number, once (the company's numbering, never the sample's)
  if (plainFields(design).some((f) => f.source?.kind === "docnumber")) {
    const type = await prisma.certificateType.findUnique({ where: { id: cert.certificateTypeId }, select: { code: true } });
    ctx.docNumber = await allocateDocNumber(cert.companyId, type?.code, new Date(), cert.id);
  }
  const resolved = Object.fromEntries(plainFields(design).map((f) => [f.key, resolveWithNeed(f, ctx, needs?.get(f.key))]));
  // a composition printed row by row: more ingredients than the design has rows is never cut silently
  // (only a table of rows 1…n — a design naming one ingredient, "activeIngredients[1]", is no table)
  // (a row: its name field by path, or by role — a whole printed row is a template of name + amount)
  const rowIndex = (f) => {
    const s = f.source?.path || f.source?.template || "";
    const m = /activeIngredients\[(\d+)\]\.name/.exec(s);
    return m && (f.role === "composition_name" || /^activeIngredients\[\d+\]\.name$/.test(f.source?.path || "")) ? Number(m[1]) : null;
  };
  const slots = plainFields(design).filter((f) => rowIndex(f) !== null);
  const idx = slots.map(rowIndex).sort((a, b) => a - b);
  const isTable = idx.length > 1 && idx.every((n, i) => n === i);
  const ingredients = Array.isArray(ctx.product?.activeIngredients) ? ctx.product.activeIngredients.length : 0;
  if (isTable && ingredients > slots.length) {
    // "المنتج فيه 16 مكوّن والقالب فيه 14 سطر" — never cut silently (the counts travel in the flag)
    const last = slots.sort((a, b) => a.sortOrder - b.sortOrder)[slots.length - 1];
    resolved[last.key] = { ...resolved[last.key], flags: [...new Set([...(resolved[last.key].flags || []), `rows_overflow:${ingredients}/${slots.length}`])] };
  }
  const resolvedGroups = resolveGroups(design.groups, design.fields, ctx);
  const draft = Object.fromEntries(plainFields(design).map((f) => [f.key, { value: resolved[f.key].value }]));
  for (const g of design.groups) draft[g.key] = { rows: resolvedGroups[g.key].rows };
  const out = await renderDesign(design, draft, { label: "generate", thumbnailScale: THUMB_SCALE });
  const values = Object.fromEntries(
    plainFields(design).map((f) => [
      f.key,
      {
        value: resolved[f.key].value,
        source: f.source,
        resolved: resolved[f.key].resolved,
        origin: resolved[f.key].origin,
        ...(resolved[f.key].provenance ? { provenance: resolved[f.key].provenance } : {}),
        flags: [...new Set([...(resolved[f.key].flags || []), ...(out.flags[f.key] || [])])],
        editedByUserId: null,
        editedAt: null,
      },
    ])
  );
  for (const g of design.groups) values[g.key] = groupValue(g, resolvedGroups[g.key], out);
  const html = await fileStore.putFile({ companyId: cert.companyId, kind: "certificate_html", buffer: Buffer.from(out.html, "utf8"), mimeType: "text/html" });
  const thumb = out.thumbnail ? await fileStore.putFile({ companyId: cert.companyId, kind: "certificate_thumb", buffer: out.thumbnail, mimeType: "image/png" }) : null;
  const [, updated] = await prisma.$transaction([
    prisma.certificateVersion.create({
      data: { certificateId: cert.id, versionNumber: 1, values, htmlFileId: html.id, thumbnailFileId: thumb?.id || null, changeSource: "generation", changedByUserId: base.userId || null },
    }),
    prisma.certificate.update({ where: { id: cert.id }, data: { status: "draft", currentVersion: 1, flagCount: countBlocking(values), error: null } }),
  ]);
  return updated;
}

async function finishBatch(batchId, fatal = null, timing = null) {
  if (fatal) {
    await prisma.certificate.updateMany({ where: { batchId, status: "pending" }, data: { status: "failed", error: fatal } });
  }
  const certs = await prisma.certificate.findMany({ where: { batchId }, select: { status: true, flagCount: true } });
  const rendered = certs.filter((c) => c.status === "draft" || c.status === "final").length;
  const failed = certs.filter((c) => c.status === "failed").length;
  const flagged = certs.filter((c) => c.status !== "failed" && c.flagCount > 0).length;
  const status = rendered === 0 ? "failed" : failed ? "partially_failed" : "done";
  const batch = await prisma.certificateBatch.update({
    where: { id: batchId },
    // timing (§15 metrics): wall-clock ms of the job and mean render ms per certificate
    data: { status, counts: { planned: certs.length, rendered, failed, flagged, ...(timing || {}) }, finishedAt: new Date() },
  });
  await prisma.invoice.update({ where: { id: batch.invoiceId }, data: { status: failed ? "partially_failed" : "generated" } });
  return { batchId, status, planned: certs.length, rendered, failed, flagged };
}

/** The `generateBatch` job (§10.2). */
export async function runGenerateBatch(batchId, ctx = {}) {
  const batch = await prisma.certificateBatch.findUnique({ where: { id: batchId }, include: { invoice: true } });
  if (!batch) throw notFound("Certificate batch");
  if (["done", "partially_failed", "failed"].includes(batch.status)) return { batchId, status: batch.status, skipped: true }; // idempotent retry
  await prisma.certificateBatch.update({ where: { id: batchId }, data: { status: "running" } });
  try {
    const company = await prisma.company.findUnique({ where: { id: batch.companyId }, select: COMPANY_SELECT });
    const invoiceBrand = batch.invoice.brandId ? await prisma.brand.findUnique({ where: { id: batch.invoice.brandId }, select: { id: true, name: true } }) : null;
    const dict = await getDictionary(batch.companyId);
    // Phase 3: a request may set one issue date for all its certificates (else today)
    const issueDate = batch.invoice?.header?.request?.issueDate ? new Date(`${batch.invoice.header.request.issueDate}T12:00:00Z`) : null;
    const base = { invoice: batch.invoice, company, invoiceBrand, today: issueDate && !Number.isNaN(issueDate.getTime()) ? issueDate : new Date(), userId: batch.startedByUserId, needs: await usableNeeds(batch.invoiceId), pathSynonyms: pathSynonymMap(dict.entries) };
    const caches = { designs: new Map(), products: new Map() };
    const certs = await prisma.certificate.findMany({
      where: { batchId },
      orderBy: { createdAt: "asc" },
      include: { items: { orderBy: { position: "asc" }, include: { invoiceItem: true } } },
    });
    const todo = certs.filter((c) => c.status === "pending");
    const total = certs.length;
    let done = total - todo.length;
    ctx.progress?.(5, `${done} of ${total}`, { batchId, done, total });

    let next = 0;
    const t0 = Date.now();
    const renderMs = [];
    const workerLoop = async () => {
      while (next < todo.length) {
        const cert = todo[next++];
        try {
          const t = Date.now();
          await renderInitialVersion(cert, base, caches);
          renderMs.push(Date.now() - t);
        } catch (err) {
          // one certificate failing never stops the batch; the failure is visible on it
          await prisma.certificate.update({ where: { id: cert.id }, data: { status: "failed", error: err.code ? `${err.code}: ${err.message}` : err.message } });
        }
        done++;
        ctx.progress?.(Math.round(5 + (90 * done) / total), `${done} of ${total}`, { batchId, done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(RENDER_CONCURRENCY, todo.length) }, workerLoop));
    const timing = { ms: Date.now() - t0, renderMsAvg: renderMs.length ? Math.round(renderMs.reduce((a, b) => a + b, 0) / renderMs.length) : null };
    return await finishBatch(batchId, null, timing);
  } catch (err) {
    await finishBatch(batchId, `Generation failed: ${err.code ? `${err.code}: ` : ""}${err.message}`);
    throw err;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────
export async function loadBatch(id, companyId) {
  const b = await prisma.certificateBatch.findUnique({ where: { id } });
  if (!b || (companyId && b.companyId !== companyId)) throw notFound("Certificate batch");
  return b;
}

/**
 * A batch's certificates as a chat card shows them (26 Nov: "Open →" went to the hidden internal
 * invoice of a no-invoice certificate): one → its own page; several → the list of that batch.
 * → { certificates: [{ id, type, products }], link }
 */
export async function certificatesOfBatch(batchId) {
  const certs = await prisma.certificate.findMany({
    where: { batchId },
    include: { certificateType: { select: { code: true } }, product: { select: { name: true } }, items: { include: { invoiceItem: { select: { product: { select: { name: true } }, data: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const certificates = certs.map((c) => ({ id: c.id, type: c.certificateType.code, products: c.product ? [c.product.name] : c.items.map((i) => i.invoiceItem?.product?.name || i.invoiceItem?.data?.name).filter(Boolean) }));
  return { certificates, link: certificates.length === 1 ? `/certificates/${certificates[0].id}` : `/certificates?batchId=${batchId}` };
}
