import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { listSizes, getLabelLayout, previewLabelLayout, saveLabelLayout, layoutPdf, layoutPreview } from "../services/label/layout/layoutService.js";
import { uploadLabelFile, getUpload, confirmRebuild, rescaleUpload } from "../services/label/layout/labelUploadService.js";
import { describeUpload, previewResize, saveResize } from "../services/label/layout/designResizeService.js";

// Printable label layouts and label uploads to resize. Thin: the services hold
// the rules. A company caller is scoped to its own labels/uploads (another
// tenant's is 404); a system user may narrow with ?companyId= and must name the
// company an upload belongs to.
const scopeFor = (req) => (req.company ? req.company.id : req.query.companyId || undefined);
const userIdOf = (req) => req.user?.id || null;
const parseJson = (v, what) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new AppError(`${what} must be JSON`, 400);
  }
};

export const getLayoutSizes = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: listSizes() });
});

export const getLayout = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await getLabelLayout(req.params.id, { companyId: scopeFor(req) }) });
});

export const postLayoutPreview = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await previewLabelLayout(req.params.id, req.body || {}, { companyId: scopeFor(req) }) });
});

export const postLayout = catchAsync(async (req, res) => {
  res.status(201).json({ status: "success", data: { layout: await saveLabelLayout(req.params.id, req.body || {}, { companyId: scopeFor(req), userId: userIdOf(req) }) } });
});

export const getLayoutPdf = catchAsync(async (req, res) => {
  const { buffer, filename } = await layoutPdf(req.params.id, { companyId: scopeFor(req) });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${filename}"`);
  res.send(buffer);
});

export const getLayoutPreview = catchAsync(async (req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.send(await layoutPreview(req.params.id, { companyId: scopeFor(req) }));
});

// multipart: file + mode (smart (default) | scale | rebuild) + layout (JSON: preset or widthMm/heightMm,
// margins, minFontPt…) or sizes (JSON array of them: one PDF each) + resize (JSON: bleedMm, cropMarks,
// minFontPt) + stretch + productId + labelId (the label this design belongs to) + country
// (+ companyId for a system user)
export const postLabelUpload = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("Attach the label file (PDF, PNG or JPEG)", 400);
  const companyId = req.company ? req.company.id : req.body.companyId;
  if (!companyId) throw new AppError("Choose the company the label belongs to", 400);
  const out = await uploadLabelFile({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype === "image/jpg" ? "image/jpeg" : req.file.mimetype,
    companyId,
    productId: req.body.productId || null,
    labelId: req.body.labelId || null,
    mode: req.body.mode || "smart",
    layout: parseJson(req.body.layout, "layout") || {},
    sizes: parseJson(req.body.sizes, "sizes") || null,
    resize: parseJson(req.body.resize, "resize") || {},
    stretch: req.body.stretch === true || req.body.stretch === "true",
    country: req.body.country || null,
    userId: userIdOf(req),
  });
  res.status(out.layout || (out.upload?.mode === "smart" && !out.taskId) ? 201 : 202).json({ status: "success", data: out });
});

export const getLabelUpload = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await getUpload(req.params.id, { companyId: scopeFor(req) }) });
});

export const postConfirmUpload = catchAsync(async (req, res) => {
  res.status(201).json({ status: "success", data: await confirmRebuild(req.params.id, req.body || {}, { companyId: scopeFor(req), userId: userIdOf(req) }) });
});

export const postRescaleUpload = catchAsync(async (req, res) => {
  res.status(201).json({ status: "success", data: { layout: await rescaleUpload(req.params.id, req.body || {}, { companyId: scopeFor(req), userId: userIdOf(req) }) } });
});

export const getUploadDesign = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await describeUpload(req.params.id, { companyId: scopeFor(req), page: Number(req.query.page) || 0 }) });
});

// body: { sizes: [{ preset } | { widthMm, heightMm }], minFontPt?, bleedMm?, cropMarks?, overrides?, page? }
export const postUploadPreview = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await previewResize(req.params.id, req.body || {}, { companyId: scopeFor(req) }) });
});

export const postUploadResize = catchAsync(async (req, res) => {
  res.status(201).json({ status: "success", data: await saveResize(req.params.id, req.body || {}, { companyId: scopeFor(req), userId: userIdOf(req) }) });
});
