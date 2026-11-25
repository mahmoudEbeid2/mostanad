import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { putFile, readFile } from "../../certificates/storage/fileStore.js";
import { resolveLayout, sizeLabel, DEFAULT_MIN_FONT_PT } from "./layoutSpec.js";
import { layoutView, minFontRule } from "./layoutService.js";
import * as resizer from "./labelResizerClient.js";

// "Change the size, keep the design": an uploaded label file (PDF, or an .ai saved
// PDF-compatible) resized by the label-resizer service — the file's own artwork,
// fonts and text are kept, nothing is re-typed. Same aspect ratio: the whole design
// is scaled. Another aspect ratio: bands stretch, logos and images keep their
// proportions, text keeps its font, size (× the scale), colour and alignment and is
// only re-wrapped when its box changes. Text that was legible never goes under the
// minimum size; when the label can't hold it there is no PDF, and the report names
// the block and suggests a size. The words, numbers and units are never changed.
// A saved size is a LabelLayout row (mode "smart") with its PDF and preview.

export const MAX_SIZES = 8;
const num = (min, max) => z.number().finite().min(min).max(max);
const resizeInput = z.object({
  sizes: z
    .array(z.object({ preset: z.string().max(20).optional(), widthMm: num(20, 400).optional(), heightMm: num(20, 400).optional() }))
    .min(1, "Choose at least one size")
    .max(MAX_SIZES, `At most ${MAX_SIZES} sizes at once`),
  minFontPt: num(4, 16).optional(),
  bleedMm: num(0, 5).default(0),
  cropMarks: z.boolean().default(false),
  // the editor's changes, per block: a new place (mm, on the new page) and/or a font size (pt)
  overrides: z
    .record(z.string().regex(/^[tg]\d{1,4}$/), z.object({ rect: z.array(num(-50, 450)).length(4).optional(), fontPt: num(2, 96).optional() }).strict())
    .default({}),
  page: z.number().int().min(0).max(50).default(0),
});

export function parseResizeInput(input = {}) {
  const parsed = resizeInput.safeParse(input || {});
  if (!parsed.success) throw new AppError(`Invalid resize: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, 400);
  const a = parsed.data;
  const sizes = a.sizes.map((s) => {
    const l = resolveLayout({ ...(s.preset ? { preset: s.preset } : {}), ...(s.widthMm ? { widthMm: s.widthMm } : {}), ...(s.heightMm ? { heightMm: s.heightMm } : {}), marginsMm: { top: 0, right: 0, bottom: 0, left: 0 } });
    return { widthMm: l.widthMm, heightMm: l.heightMm };
  });
  const seen = new Set();
  return { ...a, sizes: sizes.filter((s) => !seen.has(`${s.widthMm}x${s.heightMm}`) && seen.add(`${s.widthMm}x${s.heightMm}`)) };
}

async function loadUpload(id, companyId) {
  const u = await prisma.labelUpload.findUnique({ where: { id } });
  if (!u || (companyId && u.companyId !== companyId)) throw new AppError("Upload not found!", 404);
  return u;
}

async function designPdf(upload) {
  if (upload.mimeType !== "application/pdf") throw new AppError("This label is an image: it can only be scaled as a whole (proportions kept). Upload the PDF or .ai design to change its proportions.", 409);
  return (await readFile(upload.fileId, { companyId: upload.companyId })).buffer;
}

/** The minimum text size: the larger of the one asked for and the country's rule (regulatory rules, invariant 8). */
async function minimumFor(upload, asked) {
  const rule = upload.country ? await minFontRule(upload.country, upload.companyId) : null;
  return { minFontPt: Math.max(asked ?? DEFAULT_MIN_FONT_PT, rule?.pt ?? 0), rule };
}

/** The engine's report → the fit stored on the LabelLayout row (and shown). */
export function fitOf(r, { minFontPt, rule, bleedMm, cropMarks }) {
  const rep = r.report || {};
  return {
    mode: "smart",
    engineMode: r.mode, // scale: same proportions, the whole design scaled · smart: re-arranged
    fits: !!r.fit,
    scalePct: rep.scale ? Math.round(rep.scale * 1000) / 10 : null,
    scaleX: rep.sx ?? null,
    scaleY: rep.sy ?? null,
    smallestTextPt: rep.smallestFontPt ?? null,
    originalSmallestTextPt: rep.originalSmallestFontPt ?? null,
    textMeasurable: rep.smallestFontPt !== undefined,
    minFontPt,
    minFontRule: rule,
    belowMinimum: (rep.warnings || []).some((w) => w.code === "below_min"),
    warnings: rep.warnings || [],
    overflow: rep.overflow || [],
    suggestions: rep.suggestions || [],
    blocks: (rep.blocks || []).map((b) => ({ id: b.id, role: b.role, fontPt: b.fontPt ?? null, rewrapped: !!b.rewrapped, raisedToMin: !!b.raisedToMin, movedDownMm: b.movedDownMm || 0, lines: b.lines ?? null, rect: b.rect, scale: b.scale ?? null })),
    fontsSubstituted: rep.fontsSubstituted || [],
    boxNet: !!rep.boxNet,
    bleedMm,
    cropMarks,
  };
}

/** GET /label-uploads/:id/design → the original page and its blocks, for the editor. */
export async function describeUpload(id, { companyId, page = 0 } = {}) {
  const upload = await loadUpload(id, companyId);
  const out = await resizer.describe(await designPdf(upload), { page });
  const { minFontPt, rule } = await minimumFor(upload);
  return { uploadId: upload.id, originalName: upload.originalName, pageMm: out.pageMm, pages: out.pages, blocks: out.blocks, minFontPt, minFontRule: rule, originalDataUrl: `data:image/png;base64,${out.png.toString("base64")}` };
}

async function run(upload, input) {
  const a = parseResizeInput(input);
  const { minFontPt, rule } = await minimumFor(upload, a.minFontPt);
  const results = await resizer.resize(await designPdf(upload), { sizes: a.sizes, page: a.page, minFontPt, bleedMm: a.bleedMm, cropMarks: a.cropMarks, overrides: a.overrides });
  return { a, minFontPt, results: results.map((r) => ({ ...r, fitReport: fitOf(r, { minFontPt, rule, bleedMm: a.bleedMm, cropMarks: a.cropMarks }) })) };
}

/** POST /label-uploads/:id/preview — every size asked for, nothing saved. */
export async function previewResize(id, input, { companyId } = {}) {
  const upload = await loadUpload(id, companyId);
  const { results } = await run(upload, input);
  return {
    results: results.map((r) => ({ widthMm: r.widthMm, heightMm: r.heightMm, size: sizeLabel(r), fit: r.fitReport, previewDataUrl: `data:image/png;base64,${r.png.toString("base64")}`, pdfAvailable: !!r.pdf })),
  };
}

/** POST /label-uploads/:id/resize — every size asked for, each saved as a new version (its PDF when it fits). */
export async function saveResize(id, input, { companyId, userId = null } = {}) {
  const upload = await loadUpload(id, companyId);
  const { a, minFontPt, results } = await run(upload, input);
  const layouts = [];
  for (const r of results) {
    const pdfFile = r.pdf ? await putFile({ companyId: upload.companyId, kind: "label_pdf", buffer: r.pdf, mimeType: "application/pdf" }) : null;
    const pngFile = await putFile({ companyId: upload.companyId, kind: "label_preview", buffer: r.png, mimeType: "image/png" });
    const prev = await prisma.labelLayout.findFirst({ where: { uploadId: upload.id }, orderBy: { version: "desc" }, select: { version: true } });
    const row = await prisma.labelLayout.create({
      data: {
        companyId: upload.companyId,
        uploadId: upload.id,
        version: (prev?.version || 0) + 1,
        mode: "smart",
        widthMm: r.widthMm,
        heightMm: r.heightMm,
        settings: { minFontPt, bleedMm: a.bleedMm, cropMarks: a.cropMarks, overrides: a.overrides, page: a.page },
        fit: r.fitReport,
        pdfFileId: pdfFile?.id ?? null,
        previewFileId: pngFile.id,
        createdByUserId: userId,
      },
    });
    layouts.push(layoutView(row));
  }
  await prisma.labelUpload.update({ where: { id: upload.id }, data: { status: "ready", error: null } });
  return { layouts };
}

/** The design files uploaded for a label (newest first), with their saved sizes — the label page's "keep the design" path. */
export async function designsOfLabel(labelId, companyId) {
  const uploads = await prisma.labelUpload.findMany({ where: { labelId, companyId, mimeType: "application/pdf" }, orderBy: { createdAt: "desc" }, take: 5 });
  return Promise.all(
    uploads.map(async (u) => ({
      uploadId: u.id,
      originalName: u.originalName,
      createdAt: u.createdAt,
      layouts: (await prisma.labelLayout.findMany({ where: { uploadId: u.id }, orderBy: { version: "desc" }, take: 20 })).map(layoutView),
    }))
  );
}

const ROLE_AR = { product_name: "اسم المنتج", heading: "عنوان", paragraph: "فقرة", table: "جدول التركيب", rotated_text: "نص عمودي", barcode_digits: "أرقام الباركود", logo_or_image: "شعار / صورة" };
/** A resize's fit in plain Arabic lines (the assistant's card and answer). No technical words. */
export function fitLinesAr(fit = {}) {
  const lines = [];
  if (fit.fits === false) lines.push("لا يتّسع بهذا المقاس — لم يُعمل PDF، ولم يُقصّ أي نص.");
  else lines.push(fit.engineMode === "scale" ? `نفس التصميم مصغّرًا/مكبّرًا بنسبة ${fit.scalePct}%` : "نفس التصميم، أعيد ترتيبه على المقاس الجديد");
  if (fit.smallestTextPt != null) lines.push(`أصغر نص: ${fit.smallestTextPt} نقطة (الحد الأدنى ${fit.minFontPt} نقطة)`);
  for (const w of fit.warnings || []) {
    if (w.code === "below_min") lines.push(`⚠ بعض النص صار ${w.fontPt} نقطة — أقل من الحد الأدنى ${w.minFontPt}. اختر مقاسًا أكبر.`);
    else if (w.code === "original_below_min") lines.push(`⚠ التصميم الأصلي فيه نص ${w.fontPt} نقطة (أقل من ${w.minFontPt}) — تُرك كما هو بنفس النسبة.`);
    else if (w.code === "font_raised_to_min") lines.push(`رُفع حجم خط إلى الحد الأدنى ${w.minFontPt} نقطة.`);
  }
  if (fit.boxNet) lines.push("هذا تصميم علبة (وجوه وألسنة وخطوط قص وطي): يتغيّر مقاسه بنفس النسب فقط، لأن تغيير النسب يعني علبة أخرى.");
  for (const o of (fit.overflow || []).filter((x) => x.code !== "box_net")) lines.push(o.code === "text_too_small" ? `⚠ ${ROLE_AR[o.role] || "جزء"} «${o.text}»: نصه يصغر عن الحد الأدنى بهذا المقاس.` : `⚠ ${ROLE_AR[o.role] || "جزء"} «${o.text}» ينقصه ${o.overflowMm} مم.`);
  for (const s of fit.suggestions || []) lines.push(s.columns ? "اقتراح: النص الطويل على عمودين." : `اقتراح: مقاس ${s.widthMm / 10} × ${s.heightMm / 10} سم${s.sameRatio ? " (بنفس النسب)" : ""}.`);
  const rewrapped = (fit.blocks || []).filter((b) => b.rewrapped).length;
  if (rewrapped) lines.push(`أعيد توزيع أسطر ${rewrapped} فقرة بدون تغيير كلماتها.`);
  return lines;
}

/** A file not uploaded yet (the chat's attachment) at one or more sizes: { results } like previewResize. Nothing saved. */
export async function previewFile(buffer, input, { companyId, country = null } = {}) {
  const a = parseResizeInput(input);
  const { minFontPt, rule } = await minimumFor({ companyId, country }, a.minFontPt);
  const results = await resizer.resize(buffer, { sizes: a.sizes, page: a.page, minFontPt, bleedMm: a.bleedMm, cropMarks: a.cropMarks, overrides: a.overrides });
  return { results: results.map((r) => ({ widthMm: r.widthMm, heightMm: r.heightMm, size: sizeLabel(r), fit: fitOf(r, { minFontPt, rule, bleedMm: a.bleedMm, cropMarks: a.cropMarks }), pdfAvailable: !!r.pdf })) };
}
