import path from "path";
import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import * as pdf2htmlex from "../conversion/pdf2htmlexClient.js";
import { sanitizeTemplateHtml, describeSanitized } from "../sanitize/htmlSanitizer.js";
import * as renderer from "../engine/renderer.js";
import { computeFontCoverage } from "../analysis/fontCoverage.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { listFields, fieldsHash } from "./fieldService.js";

// Templates and their immutable versions (CERTIFICATES_V2_PLAN.md §4, §8).

export const MAX_TEMPLATE_BYTES = 60 * 1024 * 1024;
const SOURCE_FORMATS = { ".ai": "ai", ".pdf": "pdf", ".html": "html", ".htm": "html" };
const SOURCE_MIME = { ai: "application/postscript", pdf: "application/pdf", html: "text/html" };
const PX_TO_PT = 0.75; // zoom 4/3 → 1 CSS px = 1/96 in = 0.75 pt (P8)

// ── validation ───────────────────────────────────────────────────────────────
export function detectSourceFormat(originalName, buffer) {
  const format = SOURCE_FORMATS[path.extname(originalName || "").toLowerCase()];
  if (!format) throw new CertError("UNSUPPORTED_FORMAT", "Upload an Illustrator .ai, a .pdf or an .html file", 400);
  if (!buffer?.length) throw new CertError("EMPTY_FILE", "The uploaded file is empty", 400);
  if (buffer.length > MAX_TEMPLATE_BYTES) throw new CertError("FILE_TOO_LARGE", "Template files are limited to 60 MB", 413);
  if (format !== "html" && buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new CertError(
      "NO_PDF_CONTENT",
      "This file has no PDF content. Re-save the .ai in Illustrator with 'Create PDF Compatible File' checked.",
      422
    );
  }
  if (format === "html" && !/<[a-z!]/i.test(buffer.toString("utf8", 0, Math.min(buffer.length, 4096)))) {
    throw new CertError("INVALID_HTML", "The .html file does not look like HTML", 422);
  }
  return format;
}

async function assertSlotFree(tx, { companyId, certificateTypeId, brandId, country, scope }, exceptTemplateId = null) {
  const clash = await tx.certificateTemplate.findFirst({
    where: {
      companyId,
      certificateTypeId,
      brandId: brandId || null,
      country: country || null,
      scope,
      archivedAt: null,
      ...(exceptTemplateId ? { id: { not: exceptTemplateId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (clash) {
    throw new CertError(
      "TEMPLATE_SLOT_TAKEN",
      `"${clash.name}" already covers this type, brand, country and scope. Upload a new version of it instead, or archive it first.`,
      409,
      { existingTemplateId: clash.id }
    );
  }
}

async function assertRefs(tx, companyId, { certificateTypeId, brandId }) {
  if (certificateTypeId) {
    const type = await tx.certificateType.findUnique({ where: { id: certificateTypeId } });
    if (!type || type.companyId !== companyId) throw notFound("Certificate type");
  }
  if (brandId) {
    const brand = await tx.brand.findUnique({ where: { id: brandId } });
    if (!brand || brand.companyId !== companyId) throw notFound("Brand");
  }
}

const normCountry = (c) => (c ? String(c).trim().toUpperCase() : null);

// ── loading with tenant scope ────────────────────────────────────────────────
export async function loadTemplate(id, companyId) {
  const t = await prisma.certificateTemplate.findUnique({ where: { id } });
  if (!t || (companyId && t.companyId !== companyId)) throw notFound("Template");
  return t;
}

export async function loadVersion(id, companyId) {
  const v = await prisma.templateVersion.findUnique({ where: { id }, include: { template: true } });
  if (!v || (companyId && v.template.companyId !== companyId)) throw notFound("Template version");
  return v;
}

// ── upload → version → convert job ──────────────────────────────────────────
async function createVersionWithSource(tx, { template, file, format, userId, basedOnVersionId = null }) {
  const last = await tx.templateVersion.findFirst({ where: { templateId: template.id }, orderBy: { versionNumber: "desc" } });
  const source = await fileStore.putFile({
    companyId: template.companyId,
    kind: "template_source",
    buffer: file.buffer,
    mimeType: SOURCE_MIME[format],
    originalName: file.originalname,
    ext: format,
    tx,
  });
  return tx.templateVersion.create({
    data: {
      templateId: template.id,
      versionNumber: (last?.versionNumber || 0) + 1,
      status: "converting",
      sourceFormat: format,
      sourceFileId: source.id,
      basedOnVersionId,
      createdByUserId: userId || null,
    },
  });
}

async function enqueueConvert(template, version) {
  return enqueueTask({
    queueName: QUEUES.template,
    jobName: "convert",
    type: "certificate_template_convert",
    companyId: template.companyId,
    data: { entity: "template_version", entityId: version.id, versionId: version.id },
  });
}

/** POST /certificate-templates → { templateId, versionId, taskId } */
export async function createTemplateFromUpload({ companyId, userId, file, settings }) {
  const format = detectSourceFormat(file?.originalname, file?.buffer);
  const slot = {
    companyId,
    certificateTypeId: settings.certificateTypeId,
    brandId: settings.brandId || null,
    country: normCountry(settings.country),
    scope: settings.scope || "per_product",
  };
  const { template, version } = await prisma.$transaction(async (tx) => {
    await assertRefs(tx, companyId, slot);
    await assertSlotFree(tx, slot);
    const template = await tx.certificateTemplate.create({
      data: { ...slot, name: settings.name.trim(), createdByUserId: userId || null },
    });
    const version = await createVersionWithSource(tx, { template, file, format, userId });
    return { template, version };
  });
  const task = await enqueueConvert(template, version);
  return { templateId: template.id, versionId: version.id, taskId: task.id };
}

/** POST /certificate-templates/:id/versions — a new design file as draft vN+1. */
export async function uploadNewVersion({ templateId, companyId, userId, file }) {
  const template = await loadTemplate(templateId, companyId);
  if (template.archivedAt) throw new CertError("TEMPLATE_ARCHIVED", "This template is archived", 409);
  const format = detectSourceFormat(file?.originalname, file?.buffer);
  const version = await prisma.$transaction((tx) => createVersionWithSource(tx, { template, file, format, userId }));
  const task = await enqueueConvert(template, version);
  return { templateId: template.id, versionId: version.id, taskId: task.id };
}

/**
 * The `convert` job (§8.1): source → pdf2htmlEX (zoom 4/3) → sanitize →
 * analyse → thumbnail → status `draft`. Any failure leaves the version
 * `failed` with the reason (NO_PDF_CONTENT, NO_LIVE_TEXT, …) and is rethrown
 * so the task fails too.
 */
export async function convertVersion(versionId, ctx = {}) {
  const version = await prisma.templateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  if (!version) throw notFound("Template version");
  // idempotent retry: only an uploaded/converting version is converted. A late
  // retry must never reset a draft, prepared, active or failed version.
  if (!["uploaded", "converting"].includes(version.status)) return { versionId, status: version.status, skipped: true };
  const companyId = version.template.companyId;
  const t0 = Date.now();
  try {
    const { buffer } = await fileStore.readFile(version.sourceFileId);
    let raw;
    let conversion = { tool: "upload", zoom: null, warnings: [] };
    if (version.sourceFormat === "html") {
      raw = buffer.toString("utf8");
    } else {
      ctx.progress?.(15, "Converting design");
      const out = await pdf2htmlex.convert(buffer);
      raw = out.html;
      conversion = { tool: "pdf2htmlEX", version: out.toolVersion, zoom: Number(pdf2htmlex.CONVERT_ZOOM), ms: out.ms, warnings: out.warnings || [] };
      if (!out.textLines) {
        throw new CertError("NO_LIVE_TEXT", "The design has no live text — it was converted to outlines. Export it again with live text.", 422);
      }
    }

    ctx.progress?.(45, "Sanitizing");
    const s0 = Date.now();
    let html = sanitizeTemplateHtml(raw);
    if (!describeSanitized(html).isPdf2htmlEX) {
      const marked = await renderer.markGenericLines(html);
      html = sanitizeTemplateHtml(marked.html); // re-check what the browser serialised
    }
    conversion.sanitizeMs = Date.now() - s0;

    ctx.progress?.(65, "Analysing layout");
    const a0 = Date.now();
    const { pages, lines } = await renderer.analyse(html);
    conversion.analyseMs = Date.now() - a0;
    if (!lines.some((l) => l.text.trim())) {
      throw new CertError("NO_LIVE_TEXT", "The design has no live text — it was converted to outlines. Export it again with live text.", 422);
    }
    const fontCoverage = computeFontCoverage(html);

    ctx.progress?.(85, "Creating thumbnail");
    const [thumb] = await renderer.screenshotPages(html, { scale: 0.25 });

    const sanitized = await fileStore.putFile({ companyId, kind: "template_sanitized", buffer: Buffer.from(html, "utf8"), mimeType: "text/html" });
    const thumbnail = thumb
      ? await fileStore.putFile({ companyId, kind: "template_thumb", buffer: thumb.png, mimeType: "image/png" })
      : null;

    conversion.totalMs = Date.now() - t0;
    await prisma.templateVersion.update({
      where: { id: versionId },
      data: {
        status: "draft",
        error: null,
        sanitizedFileId: sanitized.id,
        thumbnailFileId: thumbnail?.id || null,
        pages: pages.map((p) => ({ ...p, widthPt: +(p.widthPx * PX_TO_PT).toFixed(2), heightPt: +(p.heightPx * PX_TO_PT).toFixed(2) })),
        lines,
        fontCoverage,
        conversion,
      },
    });
    return { versionId, status: "draft", pages: pages.length, lines: lines.length, ms: conversion.totalMs };
  } catch (err) {
    const reason = err.code ? `${err.code}: ${err.message}` : err.message;
    await prisma.templateVersion.update({ where: { id: versionId }, data: { status: "failed", error: reason } });
    throw err;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────
const versionSummary = (v) => ({
  id: v.id,
  versionNumber: v.versionNumber,
  status: v.status,
  sourceFormat: v.sourceFormat,
  error: v.error,
  createdAt: v.createdAt,
  hasThumbnail: !!v.thumbnailFileId,
});

export async function listTemplates(companyId, { certificateTypeId, brandId, country, scope, status, includeArchived, page = 1, limit = 20 } = {}) {
  const where = {
    companyId,
    ...(certificateTypeId ? { certificateTypeId } : {}),
    ...(brandId ? { brandId } : {}),
    ...(country ? { country: normCountry(country) } : {}),
    ...(scope ? { scope } : {}),
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(status ? { versions: { some: { status } } } : {}),
  };
  const take = Math.min(Number(limit) || 20, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const [total, rows] = await prisma.$transaction([
    prisma.certificateTemplate.count({ where }),
    prisma.certificateTemplate.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take,
      include: {
        certificateType: { select: { id: true, name: true, code: true } },
        brand: { select: { id: true, name: true } },
        versions: { orderBy: { versionNumber: "desc" } },
      },
    }),
  ]);
  return {
    total,
    templates: rows.map((t) => ({
      ...t,
      versions: t.versions.map(versionSummary),
      latestVersion: t.versions[0] ? versionSummary(t.versions[0]) : null,
      activeVersion: t.versions.find((v) => v.id === t.activeVersionId) ? versionSummary(t.versions.find((v) => v.id === t.activeVersionId)) : null,
    })),
  };
}

export async function getTemplate(id, companyId) {
  await loadTemplate(id, companyId);
  const t = await prisma.certificateTemplate.findUnique({
    where: { id },
    include: {
      certificateType: { select: { id: true, name: true, code: true } },
      brand: { select: { id: true, name: true } },
      versions: { orderBy: { versionNumber: "desc" } },
    },
  });
  return { ...t, versions: t.versions.map(versionSummary) };
}

export async function getVersionDetail(id, companyId) {
  const v = await loadVersion(id, companyId);
  const fields = await listFields(id);
  const { template, ...rest } = v;
  const hash = fieldsHash(fields);
  return {
    ...rest,
    template: { id: template.id, name: template.name, companyId: template.companyId, scope: template.scope, activeVersionId: template.activeVersionId, archivedAt: template.archivedAt },
    fields,
    fieldsHash: hash,
    // a report made for a different field list no longer describes this version
    prepareReportStale: !!v.prepareReport && v.prepareReport.fieldsHash !== hash,
  };
}

/** → { html, row } for variant sanitized | prepared (sample is rendered by the field service). */
export async function getVersionHtml(id, companyId, variant = "sanitized") {
  const v = await loadVersion(id, companyId);
  const fileId = variant === "prepared" ? v.preparedFileId : v.sanitizedFileId;
  if (!fileId) throw new CertError("NOT_AVAILABLE", `The ${variant} HTML is not available for this version (status ${v.status})`, 409);
  return { version: v, html: await fileStore.readText(fileId) };
}

export async function getThumbnail(id, companyId) {
  const v = await loadVersion(id, companyId);
  if (!v.thumbnailFileId) throw notFound("Thumbnail");
  return fileStore.readFile(v.thumbnailFileId);
}

// ── settings / archive ───────────────────────────────────────────────────────
export async function updateTemplateSettings(id, companyId, patch) {
  const current = await loadTemplate(id, companyId);
  const next = {
    companyId: current.companyId,
    certificateTypeId: patch.certificateTypeId ?? current.certificateTypeId,
    brandId: patch.brandId !== undefined ? patch.brandId || null : current.brandId,
    country: patch.country !== undefined ? normCountry(patch.country) : current.country,
    scope: patch.scope ?? current.scope,
  };
  return prisma.$transaction(async (tx) => {
    await assertRefs(tx, current.companyId, next);
    if (!current.archivedAt) await assertSlotFree(tx, next, id);
    return tx.certificateTemplate.update({
      where: { id },
      data: { ...next, companyId: undefined, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) },
    });
  });
}

export async function archiveTemplate(id, companyId) {
  const t = await loadTemplate(id, companyId);
  if (t.archivedAt) return t;
  return prisma.$transaction(async (tx) => {
    if (t.activeVersionId) await tx.templateVersion.update({ where: { id: t.activeVersionId }, data: { status: "superseded" } });
    return tx.certificateTemplate.update({ where: { id }, data: { archivedAt: new Date(), activeVersionId: null } });
  });
}
