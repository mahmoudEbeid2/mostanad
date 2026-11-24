import crypto from "node:crypto";
import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { putFile, readFile } from "../../certificates/storage/fileStore.js";
import { addLabelJob } from "../../../lib/queue.js";
import { resolveLayout, sizeLabel, DEFAULT_MIN_FONT_PT } from "./layoutSpec.js";
import { scaleToPage, pageSizeMm } from "./labelPdf.js";
import { layoutView, saveLabelLayout, minFontRule } from "./layoutService.js";
import { textOf, normLine } from "./labelHtml.js";

// "Upload a label and change its size" — labels the client already has as files.
//   scale (the default): the file itself is put on the new page (proportions
//     kept, centred) — the artwork is kept — with its scale, the smallest text
//     size after scaling (PDF text layer only) and a warning below the minimum;
//     "stretch" only with an explicit warning.
//   rebuild (only when chosen): the file is read into a label by the existing
//     label extraction (labelExtractor, origin "extracted") and re-typed in a
//     plain layout, without the original design; every field is shown to the
//     person to check — what the file doesn't state stays EMPTY and is listed,
//     nothing is filled in — and once they confirm, it is laid out like any label.
// Files are StoredFiles of the upload's company; every read is tenant-scoped.

export const UPLOAD_TYPES = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // uploadLabel (multer) refuses larger first
const STRETCH_WARNING = "Stretched to fill: the text is distorted (wider or taller than designed). Check it is still legible before printing.";

/** The labelData fields an extraction reads (labelExtractor's extractionMeta keys → labelData paths). */
export const REVIEW_FIELDS = [
  "productName", "pharmaceuticalForm", "strength", "activeIngredients", "targetAnimalSpecies", "aimOfUse", "indications", "routeOfAdministration", "directionOfUse",
  "contraindications", "warnings", "userSafety", "withdrawalPeriod", "storage", "shelfLifeAfterOpening", "netWeight", "packaging", "registrationNumber", "manufacturer", "importer",
  "keepOutOfReachOfChildren",
];

const view = (u) => ({ id: u.id, mode: u.mode, status: u.status, originalName: u.originalName, mimeType: u.mimeType, labelId: u.labelId, taskId: u.taskId, error: u.error, productId: u.productId, country: u.country, createdAt: u.createdAt });

async function loadUpload(id, companyId) {
  const u = await prisma.labelUpload.findUnique({ where: { id } });
  if (!u || (companyId && u.companyId !== companyId)) throw new AppError("Upload not found!", 404);
  return u;
}

/**
 * POST /label-uploads (multipart: file, mode, size…). → { upload, layout? }
 * scale: done now (a LabelLayout row with the PDF). rebuild: a background
 * extraction (BackgroundTask + labelQueue); the label then waits for review.
 */
export async function uploadLabelFile({ buffer, originalName, mimeType, companyId, productId = null, mode = "scale", layout: layoutInput = {}, stretch = false, country = null, userId = null }) {
  if (!companyId) throw new AppError("Choose the company the label belongs to", 400);
  if (!UPLOAD_TYPES[mimeType]) throw new AppError("Upload a PDF, PNG or JPEG label", 400);
  if (!buffer?.length) throw new AppError("The file is empty", 400);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError("The label file is larger than 15 MB", 400);
  if (!["rebuild", "scale"].includes(mode)) throw new AppError('mode must be "rebuild" or "scale"', 400);
  if (productId) {
    const p = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
    if (!p) throw new AppError("Product not found!", 404);
  }
  const target = resolveLayout(layoutInput);
  const file = await putFile({ companyId, kind: "label_upload", buffer, mimeType, originalName: originalName || null });
  const upload = await prisma.labelUpload.create({
    data: { companyId, productId, fileId: file.id, originalName: originalName || null, mimeType, mode, status: "uploaded", country: country ? String(country).toUpperCase().slice(0, 2) : null, createdByUserId: userId },
  });
  if (mode === "scale") {
    const layout = await scaleUpload(upload, { layout: target, stretch, userId });
    return { upload: view(await loadUpload(upload.id)), layout };
  }
  const task = await prisma.backgroundTask.create({ data: { type: "label_rebuild_extraction", status: "pending", companyId } });
  await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "extracting", taskId: task.id } });
  await addLabelJob(task.id, { kind: "rebuild", uploadId: upload.id, companyId, target });
  return { upload: view(await loadUpload(upload.id)), taskId: task.id, target: { ...target, size: sizeLabel(target) } };
}

/** scale mode: the file on a page of exactly the target size → a LabelLayout row (mode "scale") */
async function scaleUpload(upload, { layout, stretch, userId }) {
  const { buffer } = await readFile(upload.fileId, { companyId: upload.companyId });
  const rule = upload.country ? await minFontRule(upload.country, upload.companyId) : null;
  const minFontPt = Math.max(layout.minFontPt ?? DEFAULT_MIN_FONT_PT, rule?.pt ?? 0);
  let out;
  try {
    out = await scaleToPage(buffer, upload.mimeType, { widthMm: layout.widthMm, heightMm: layout.heightMm, stretch });
  } catch (err) {
    await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "failed", error: err.message } });
    throw new AppError(`Couldn't place the label on the new page: ${err.message}`, err.statusCode || 400);
  }
  const warnings = [];
  if (stretch) warnings.push(STRETCH_WARNING);
  if (!out.textMeasurable) warnings.push(out.source.kind === "image" ? "This is an image: its smallest text size can't be measured. Check the printed size by eye." : "This PDF has no text layer (outlined or scanned): its smallest text size can't be measured.");
  else if (out.smallestTextPt < minFontPt) warnings.push(`After scaling, the smallest text is ${out.smallestTextPt} pt — below the ${minFontPt} pt minimum${rule ? ` (${rule.ruleKey})` : ""}. A larger size keeps it legible; "Rebuild" re-types the text larger but drops the original design.`);
  const fit = {
    mode: "scale",
    fits: true,
    stretch: !!stretch,
    scalePct: out.scalePct,
    scaleX: out.scaleX,
    scaleY: out.scaleY,
    source: out.source,
    smallestTextPt: out.smallestTextPt,
    textMeasurable: out.textMeasurable,
    minFontPt,
    belowMinimum: out.textMeasurable && out.smallestTextPt < minFontPt,
    warnings,
  };
  const pdfFile = await putFile({ companyId: upload.companyId, kind: "label_pdf", buffer: out.pdf, mimeType: "application/pdf" });
  const prev = await prisma.labelLayout.findFirst({ where: { uploadId: upload.id }, orderBy: { version: "desc" }, select: { version: true } });
  const row = await prisma.labelLayout.create({
    data: { companyId: upload.companyId, uploadId: upload.id, version: (prev?.version || 0) + 1, mode: "scale", widthMm: layout.widthMm, heightMm: layout.heightMm, settings: { stretch: !!stretch, minFontPt }, fit, pdfFileId: pdfFile.id, createdByUserId: userId },
  });
  await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "ready", error: null } });
  return layoutView(row);
}

/** POST /label-uploads/:id/scale — the same uploaded file at another size (scale mode). */
export async function rescaleUpload(id, { layout: layoutInput = {}, stretch = false }, { companyId, userId = null } = {}) {
  const upload = await loadUpload(id, companyId);
  return scaleUpload(upload, { layout: resolveLayout(layoutInput), stretch, userId });
}

/**
 * Worker step (labelQueue job kind "rebuild"): the file → labelExtractor → a label
 * (origin "extracted", status draft) whose fields the file didn't state are EMPTY.
 * `extract` is injectable for tests. → { labelId, read, missing }
 */
export async function runRebuildExtraction({ uploadId, companyId }, { extract, onProgress } = {}) {
  const upload = await loadUpload(uploadId, companyId);
  try {
    const { buffer } = await readFile(upload.fileId, { companyId: upload.companyId });
    if (!extract) {
      if (process.env.MOCK_GEMINI === "true" || !process.env.GEMINI_API_KEY) throw new AppError("AI isn't set up on this server, so the label can't be read. Use \"Keep the original design, just scale\" instead.", 503);
      ({ extract } = await import("../extraction/labelExtractor.js"));
    }
    const res = await extract(buffer, upload.originalName || `label.${UPLOAD_TYPES[upload.mimeType]}`, upload.mimeType, upload.country || "", upload.companyId, onProgress);
    const { labelData, read, missing } = onlyWhatWasRead(res.labelData, res.extractionMeta);
    const label = await prisma.generatedLabel.create({
      data: {
        companyId: upload.companyId,
        productId: upload.productId,
        createdByUserId: upload.createdByUserId,
        inputPayload: { source: "label_upload", uploadId: upload.id, fileId: upload.fileId, originalName: upload.originalName },
        labelData,
        labelProvenance: Object.fromEntries(read.map((f) => [f, { tier: "extracted", source: "label_upload", uploadId: upload.id, confidence: res.extractionMeta?.[f]?.confidence ?? null, confirmed: false, at: new Date().toISOString() }])),
        schemaVersion: labelData.schemaVersion || "vet-label@2.0.0",
        country: upload.country || "XX",
        language: "en",
        status: "draft",
        origin: "extracted",
        extractionMeta: { ...(res.extractionMeta || {}), rebuild: { uploadId: upload.id, read, missing, confirmedAt: null } },
        sourceFileRef: upload.fileId,
      },
    });
    await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "review", labelId: label.id, error: null } });
    return { labelId: label.id, read, missing };
  } catch (err) {
    await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "failed", error: String(err.message).slice(0, 1000) } });
    throw err;
  }
}

const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && v.translations && !Object.values(v.translations).some((t) => String(t || "").trim()));

/**
 * labelExtractor fills what a label didn't state with stand-ins ("Unknown",
 * amount "q.s.", the upload's country as country of production, "keep out of
 * reach" = true). A rebuilt label must not print any of those: a field the
 * extraction didn't read (no extractionMeta entry) is emptied, and listed.
 */
export function onlyWhatWasRead(labelData, meta = {}) {
  const d = JSON.parse(JSON.stringify(labelData || {}));
  const readKeys = new Set(Object.keys(meta || {}).filter((k) => k !== "targetAnimalSpecies" || (meta.targetAnimalSpecies?.confidence ?? 0) > 0));
  const empty = (f) => {
    if (Array.isArray(d[f])) d[f] = [];
    else d[f] = null;
  };
  for (const f of REVIEW_FIELDS) {
    if (f === "keepOutOfReachOfChildren") {
      if (!readKeys.has(f)) d[f] = null;
      continue;
    }
    if (!readKeys.has(f) || isEmpty(d[f])) empty(f);
  }
  if (Array.isArray(d.activeIngredients)) d.activeIngredients = d.activeIngredients.filter((i) => String(i?.translations?.en || i?.primary || "").trim() && i.translations?.en !== "Unknown");
  dedupeRead(d);
  d.countryOfProduction = readKeys.has("countryOfProduction") ? d.countryOfProduction : null;
  d.batchNo = null; // a label file's batch / dates belong to one print run: the new label has blanks
  d.productionDate = null;
  d.expiryDate = null;
  const read = REVIEW_FIELDS.filter((f) => !isEmpty(d[f]) && d[f] !== null);
  const missing = REVIEW_FIELDS.filter((f) => !read.includes(f));
  return { labelData: d, read, missing };
}

/**
 * The same text read twice from one label (an extraction often puts the aim of
 * use into indications as well, or repeats a warning): list items that repeat
 * an earlier item, or the aim of use, are dropped before the person reviews
 * them. Mutates `d`.
 */
function dedupeRead(d) {
  const aim = normLine(textOf(d.aimOfUse, "en"));
  for (const f of ["indications", "warnings", "userSafety"]) {
    if (!Array.isArray(d[f])) continue;
    const seen = new Set(f === "indications" && aim ? [aim] : []);
    d[f] = d[f].filter((x) => {
      const n = normLine(textOf(x, "en"));
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }
}

/**
 * The labelQueue job for a rebuild upload (labelWorker hands it here): the
 * BackgroundTask goes processing → completed { labelId, read, missing, target } | failed.
 */
export async function processRebuildTask(taskId, data, { emit = () => {}, extract } = {}) {
  await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing", progress: 5, message: "Reading the label" } });
  emit({ status: "processing", progress: 5, message: "Reading the label" });
  try {
    const out = await runRebuildExtraction(data, {
      extract,
      onProgress: (progress, message) => {
        emit({ status: "processing", progress, message });
        prisma.backgroundTask.update({ where: { id: taskId }, data: { progress, message } }).catch((err) => console.error(`[labelUpload] progress for ${taskId} not saved: ${err.message}`));
      },
    });
    const result = { ...out, uploadId: data.uploadId, target: data.target };
    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", progress: 100, message: "Read — check the fields", result } });
    emit({ status: "completed", result });
    return result;
  } catch (err) {
    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "failed", error: String(err.message).slice(0, 2000) } });
    emit({ status: "failed", error: err.message });
    return null;
  }
}

/** GET /label-uploads/:id → { upload, label?: { id, fields: [{ field, value, read }], missing }, layouts, task } */
export async function getUpload(id, { companyId } = {}) {
  const u = await loadUpload(id, companyId);
  const [label, layouts, task] = await Promise.all([
    u.labelId ? prisma.generatedLabel.findUnique({ where: { id: u.labelId }, select: { id: true, labelData: true, extractionMeta: true } }) : null,
    prisma.labelLayout.findMany({ where: u.labelId ? { OR: [{ uploadId: u.id }, { labelId: u.labelId }] } : { uploadId: u.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    u.taskId ? prisma.backgroundTask.findUnique({ where: { id: u.taskId }, select: { id: true, status: true, progress: true, message: true, error: true } }) : null,
  ]);
  const rebuild = label?.extractionMeta?.rebuild;
  return {
    upload: view(u),
    file: { pageSize: u.mimeType === "application/pdf" ? await pageSizeMm((await readFile(u.fileId, { companyId: u.companyId })).buffer).catch(() => null) : null },
    label: label ? { id: label.id, fields: REVIEW_FIELDS.map((f) => ({ field: f, value: label.labelData?.[f] ?? null, read: (rebuild?.read || []).includes(f) })), missing: rebuild?.missing || [], confirmedAt: rebuild?.confirmedAt || null } : null,
    layouts: layouts.map(layoutView),
    task,
  };
}

/**
 * POST /label-uploads/:id/confirm { fields?: { field: value } } — the person checked
 * the extracted fields (and may correct or fill them in). The label is then laid
 * out at the size chosen at upload (or `layout`). Only REVIEW_FIELDS can be set.
 * → { label, layout }
 */
export async function confirmRebuild(id, { fields = {}, layout: layoutInput = null } = {}, { companyId, userId = null } = {}) {
  const u = await loadUpload(id, companyId);
  if (u.mode !== "rebuild" || !u.labelId) throw new AppError("This upload has no label to confirm yet", 409);
  const label = await prisma.generatedLabel.findUnique({ where: { id: u.labelId } });
  const bad = Object.keys(fields).filter((f) => !REVIEW_FIELDS.includes(f));
  if (bad.length) throw new AppError(`These fields can't be set here: ${bad.join(", ")}`, 400);
  const data = { ...label.labelData };
  const prov = { ...(label.labelProvenance || {}) };
  const at = new Date().toISOString();
  for (const [f, v] of Object.entries(fields)) {
    data[f] = normalizeField(f, v);
    prov[f] = { tier: "user", source: "label_upload_review", byUserId: userId, at };
  }
  for (const f of Object.keys(prov)) if (prov[f]?.tier === "extracted") prov[f] = { ...prov[f], confirmed: true, confirmedAt: at };
  const rebuild = { ...(label.extractionMeta?.rebuild || {}), confirmedAt: at, confirmedByUserId: userId, edited: Object.keys(fields) };
  rebuild.read = REVIEW_FIELDS.filter((f) => !isEmpty(data[f]));
  rebuild.missing = REVIEW_FIELDS.filter((f) => !rebuild.read.includes(f));
  await prisma.generatedLabel.update({ where: { id: label.id }, data: { labelData: data, labelProvenance: prov, extractionMeta: { ...(label.extractionMeta || {}), rebuild } } });
  const task = u.taskId ? await prisma.backgroundTask.findUnique({ where: { id: u.taskId }, select: { result: true } }) : null;
  const target = layoutInput || task?.result?.target || {};
  const layout = await saveLabelLayout(label.id, target, { companyId: u.companyId, userId });
  await prisma.labelUpload.update({ where: { id: u.id }, data: { status: "ready" } });
  return { labelId: label.id, layout, missing: rebuild.missing };
}

const lt = (s) => ({ translations: { en: String(s).trim() }, primary: "en" });
/** A value the person typed → the labelData shape of that field. */
function normalizeField(f, v) {
  if (v === null || v === undefined || v === "") return ["warnings", "userSafety", "indications", "activeIngredients"].includes(f) ? [] : null;
  if (f === "keepOutOfReachOfChildren") return v === true || v === "true";
  if (f === "registrationNumber") return String(v).trim();
  if (f === "activeIngredients") {
    const rows = Array.isArray(v) ? v : String(v).split(/\n|;/);
    return rows
      .map((r) => (typeof r === "object" ? r : { name: String(r).trim() }))
      .filter((r) => (r.name || r.translations?.en || "").trim())
      .map((r) => (r.translations ? r : { translations: { en: r.name.trim() }, primary: "en", amount: (r.amount || r.concentration || "").trim(), unit: r.unit || null, normalizedName: r.name.trim().toLowerCase() }));
  }
  if (f === "targetAnimalSpecies") {
    const list = (Array.isArray(v) ? v : String(v).split(/,|،|\n/)).map((x) => String(x).trim()).filter(Boolean);
    return list.length ? { translations: { en: list.join(", ") }, primary: "en", list, source: "confirmed" } : null;
  }
  if (["warnings", "userSafety", "indications"].includes(f)) return (Array.isArray(v) ? v : String(v).split(/\n/)).map((x) => (typeof x === "object" ? x : String(x).trim())).filter(Boolean).map((x) => (typeof x === "object" ? x : lt(x)));
  return typeof v === "object" ? v : lt(v);
}

export const _test = { normalizeField, isEmpty, STRETCH_WARNING, newId: () => crypto.randomUUID() };
