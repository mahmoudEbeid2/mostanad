import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { runPrepare, renderFilled, fillDef } from "./prepareEngine.js";
import { loadVersion } from "./templateService.js";
import { listFields, fieldsHash } from "./fieldService.js";
import { resolveAll } from "../generation/valueResolver.js";
import { loadProductContext } from "../generation/contextLoader.js";

// Prepare → ready → activate, new version, previews (CERTIFICATES_V2_PLAN.md
// §7.3–§7.6, §8.4, D10, D11). Every number comes from the backend renderer.

/** POST /template-versions/:id/prepare → 202 { versionId, taskId } */
export async function startPrepare(versionId, companyId) {
  const version = await loadVersion(versionId, companyId);
  if (version.status !== "draft") throw new CertError("VERSION_NOT_DRAFT", `Only a draft version can be prepared (this one is ${version.status})`, 409);
  const count = await prisma.templateField.count({ where: { versionId } });
  if (!count) throw new CertError("NO_FIELDS", "Mark at least one field before preparing", 422);
  const claimed = await prisma.templateVersion.updateMany({ where: { id: versionId, status: "draft" }, data: { status: "preparing", error: null } });
  if (!claimed.count) throw new CertError("VERSION_NOT_DRAFT", "This version is already being prepared", 409);
  try {
    const task = await enqueueTask({
      queueName: QUEUES.template,
      jobName: "prepare",
      type: "certificate_template_prepare",
      companyId: version.template.companyId,
      data: { entity: "template_version", entityId: versionId, versionId },
    });
    return { versionId, taskId: task.id };
  } catch (err) {
    await prisma.templateVersion.update({ where: { id: versionId }, data: { status: "draft", error: `Could not queue prepare: ${err.message}` } });
    throw err;
  }
}

/**
 * The `prepare` job. Gate passed → `ready` with the prepared file and field
 * geometry; gate failed → back to `draft` with the report (editable, §7.6).
 * An infrastructure error → `draft` with `error`, and rethrown (task failed).
 */
export async function runPrepareJob(versionId, ctx = {}) {
  const version = await prisma.templateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  if (!version) throw notFound("Template version");
  const fields = await listFields(versionId);
  const hash = fieldsHash(fields);
  // idempotent retry — also when the version was activated (or superseded) since
  if (["ready", "active", "superseded"].includes(version.status) && version.prepareReport?.fieldsHash === hash) return { versionId, status: version.status, skipped: true };
  if (version.status !== "preparing") throw new CertError("VERSION_NOT_PREPARING", `Version is ${version.status}, not preparing`, 409);
  const companyId = version.template.companyId;
  try {
    ctx.progress?.(10, "Clearing fields");
    const sanitized = await fileStore.readText(version.sanitizedFileId);
    const { preparedHtml, geometry, report, diffImages } = await runPrepare(sanitized, fields, { fontCoverage: version.fontCoverage });
    ctx.progress?.(80, "Saving the report");

    const diffs = [];
    for (const d of diffImages) {
      const row = await fileStore.putFile({ companyId, kind: "template_diff", buffer: d.png, mimeType: "image/png" });
      diffs.push({ page: d.page, fileId: row.id });
    }
    const fullReport = { ...report, fieldsHash: hash, diffImages: diffs };

    if (!report.passed) {
      await prisma.templateVersion.update({ where: { id: versionId }, data: { status: "draft", prepareReport: fullReport } });
      return { versionId, status: "draft", passed: false, failing: report.checks.filter((c) => !c.passed).map((c) => c.id) };
    }

    const prepared = await fileStore.putFile({ companyId, kind: "template_prepared", buffer: Buffer.from(preparedHtml, "utf8"), mimeType: "text/html" });
    await prisma.$transaction([
      ...fields.map((f) =>
        prisma.templateField.update({
          where: { versionId_key: { versionId, key: f.key } },
          data: geometry[f.key],
        })
      ),
      prisma.templateVersion.update({ where: { id: versionId }, data: { status: "ready", preparedFileId: prepared.id, prepareReport: fullReport, error: null } }),
    ]);
    return { versionId, status: "ready", passed: true, pixelDiffPct: report.pixelDiffPct };
  } catch (err) {
    await prisma.templateVersion.update({ where: { id: versionId }, data: { status: "draft", error: `Prepare failed: ${err.code ? `${err.code}: ` : ""}${err.message}` } });
    throw err;
  }
}

/** POST /template-versions/:id/activate (§8.4, D10). */
export async function activateVersion(versionId, companyId) {
  const version = await loadVersion(versionId, companyId);
  if (version.status !== "ready") throw new CertError("VERSION_NOT_READY", `Only a ready version can be activated (this one is ${version.status})`, 409);
  if (version.template.archivedAt) throw new CertError("TEMPLATE_ARCHIVED", "This template is archived", 409);
  const unconfirmed = await prisma.templateField.findMany({ where: { versionId, confirmed: false }, select: { key: true } });
  if (unconfirmed.length) {
    throw new CertError("FIELDS_UNCONFIRMED", `Confirm every field before activating: ${unconfirmed.map((f) => f.key).join(", ")}`, 409, {
      fields: unconfirmed.map((f) => f.key),
    });
  }
  const t = version.template;
  return prisma.$transaction(async (tx) => {
    // the template slot is unique among non-archived templates (§6.1); the
    // partial index enforces it, this gives a readable error first
    const clash = await tx.certificateTemplate.findFirst({
      where: { id: { not: t.id }, companyId: t.companyId, certificateTypeId: t.certificateTypeId, brandId: t.brandId, country: t.country, scope: t.scope, archivedAt: null },
      select: { id: true, name: true },
    });
    if (clash) throw new CertError("TEMPLATE_SLOT_TAKEN", `"${clash.name}" already covers this slot`, 409, { existingTemplateId: clash.id });
    // compare-and-set (review #9): every write is conditioned on the state read
    // above, so two activations racing (or an archive in between) can't both win
    // — the loser gets a 409 and the transaction rolls back
    const previous = t.activeVersionId && t.activeVersionId !== versionId ? t.activeVersionId : null;
    const slot = await tx.certificateTemplate.updateMany({ where: { id: t.id, activeVersionId: t.activeVersionId, archivedAt: null }, data: { activeVersionId: versionId } });
    if (slot.count !== 1) throw new CertError("VERSION_CONFLICT", "This template's active version changed meanwhile — reload and try again", 409);
    const mine = await tx.templateVersion.updateMany({ where: { id: versionId, status: "ready" }, data: { status: "active" } });
    if (mine.count !== 1) throw new CertError("VERSION_CONFLICT", "This version changed meanwhile (it is no longer ready) — reload and try again", 409);
    if (previous) await tx.templateVersion.updateMany({ where: { id: previous, status: "active" }, data: { status: "superseded" } });
    return { versionId, templateId: t.id, status: "active", supersededVersionId: previous };
  });
}

/** POST /template-versions/:id/new-version — clone as draft vN+1 (same design, same fields). */
export async function cloneVersion(versionId, companyId, userId) {
  const v = await loadVersion(versionId, companyId);
  if (!v.sanitizedFileId) throw new CertError("VERSION_NOT_CONVERTED", "This version has no converted design to copy", 409);
  if (v.template.archivedAt) throw new CertError("TEMPLATE_ARCHIVED", "This template is archived", 409);
  const fields = await listFields(versionId);
  return prisma.$transaction(async (tx) => {
    const last = await tx.templateVersion.findFirst({ where: { templateId: v.templateId }, orderBy: { versionNumber: "desc" } });
    const copy = await tx.templateVersion.create({
      data: {
        templateId: v.templateId,
        versionNumber: last.versionNumber + 1,
        status: "draft",
        sourceFormat: v.sourceFormat,
        sourceFileId: v.sourceFileId,
        sanitizedFileId: v.sanitizedFileId,
        thumbnailFileId: v.thumbnailFileId,
        pages: v.pages ?? undefined,
        lines: v.lines ?? undefined,
        fontCoverage: v.fontCoverage ?? undefined,
        conversion: v.conversion ?? undefined,
        basedOnVersionId: v.id,
        createdByUserId: userId || null,
      },
    });
    if (fields.length) {
      await tx.templateField.createMany({
        // geometry is recomputed by the next prepare
        data: fields.map(({ id, box, limits, letterSpacing, fontClass, scale, ...f }) => ({ ...f, format: f.format ?? undefined, versionId: copy.id })),
      });
    }
    return { templateId: v.templateId, versionId: copy.id, versionNumber: copy.versionNumber, status: "draft" };
  });
}

// ── previews (never stored) ──────────────────────────────────────────────────
async function preparedDoc(version) {
  if (!version.preparedFileId) throw new CertError("NOT_PREPARED", `Prepare the version first (it is ${version.status})`, 409);
  const [html, fields] = await Promise.all([fileStore.readText(version.preparedFileId), listFields(version.id)]);
  return { html, fields };
}

/** GET /template-versions/:id/html?variant=sample — the prepared design refilled with its own sample values. */
export async function renderSample(versionId, companyId) {
  const version = await loadVersion(versionId, companyId);
  const { html, fields } = await preparedDoc(version);
  const values = Object.fromEntries(fields.map((f) => [f.key, f.sampleValue]));
  return (await renderFilled(html, fields.map(fillDef), values, { fontCoverage: version.fontCoverage, label: "sample" })).html;
}

/**
 * POST /template-versions/:id/preview — { values?, productId?, invoiceItemId? }
 * Resolves values from the chosen product / invoice line, then applies
 * explicit `values` on top. → { html, values: { key: { value, flags } }, flags }
 */
export async function preview(versionId, companyId, { values = {}, productId = null, invoiceItemId = null } = {}) {
  const version = await loadVersion(versionId, companyId);
  const { html, fields } = await preparedDoc(version);
  const ctx = await loadProductContext(version.template.companyId, { productId, invoiceItemId });
  const resolved = resolveAll(fields, ctx);
  const final = {};
  for (const f of fields) {
    const explicit = Object.prototype.hasOwnProperty.call(values, f.key);
    final[f.key] = explicit ? { value: String(values[f.key] ?? ""), flags: [], origin: "manual" } : { ...resolved[f.key], origin: "auto" };
  }
  const out = await renderFilled(
    html,
    fields.map(fillDef),
    Object.fromEntries(Object.entries(final).map(([k, v]) => [k, v.value])),
    { fontCoverage: version.fontCoverage, label: "preview" }
  );
  const flags = Object.fromEntries(fields.map((f) => [f.key, [...new Set([...(final[f.key].flags || []), ...(out.flags[f.key] || [])])]]));
  return { html: out.html, values: final, flags };
}

/** GET /template-versions/:id/prepare-diff?page=n → PNG buffer. */
export async function getDiffImage(versionId, companyId, page = 1) {
  const version = await loadVersion(versionId, companyId);
  const entry = version.prepareReport?.diffImages?.find((d) => d.page === Number(page));
  if (!entry) throw notFound("Diff image");
  return fileStore.readFile(entry.fileId, { companyId: version.template.companyId });
}
