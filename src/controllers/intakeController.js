import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { actorFrom } from "./assistantController.js";
import { mayUse } from "../services/assistant/registry/access.js";
import * as intake from "../services/intake/intakeService.js";

// "ارفع ملفاتك" — auto-intake. The caller (a company session or a system user)
// owns its drops; permissions are checked by action at execute.
const actorOf = (req) => {
  const a = actorFrom(req);
  return { ...a, can: (slug) => mayUse(a, slug) };
};

export const listBatches = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { batches: await intake.listBatches(actorOf(req), req.query) } });
});

export const createBatch = catchAsync(async (req, res) => {
  const batch = await intake.createBatch(actorOf(req), { companyId: req.body?.companyId || null });
  res.status(201).json({ status: "success", data: { batch: { id: batch.id, status: batch.status, companyId: batch.companyId }, chunkBytes: intake.CHUNK_BYTES, maxFileBytes: intake.MAX_FILE_BYTES, accepted: intake.ACCEPTED } });
});

export const addFile = catchAsync(async (req, res) => {
  const item = await intake.addFile(actorOf(req), req.params.id, { name: req.body?.name, size: Number(req.body?.size), relPath: req.body?.relPath || null });
  res.status(201).json({ status: "success", data: { item: { id: item.id, name: item.name, receivedBytes: item.receivedBytes, sizeBytes: item.sizeBytes } } });
});

export const putChunk = catchAsync(async (req, res, next) => {
  if (!Buffer.isBuffer(req.body)) return next(new AppError("Send the chunk as application/octet-stream", 400));
  try {
    const out = await intake.putChunk(actorOf(req), req.params.itemId, Number(req.query.offset) || 0, req.body);
    res.status(200).json({ status: "success", data: out });
  } catch (err) {
    if (err.code === "RESUME_FROM") return res.status(409).json({ status: "fail", code: err.code, message: err.message, receivedBytes: err.receivedBytes });
    throw err;
  }
});

export const startClassify = catchAsync(async (req, res) => {
  res.status(202).json({ status: "success", data: await intake.startClassify(actorOf(req), req.params.id) });
});

export const getBatch = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await intake.getBatchView(actorOf(req), req.params.id) });
});

export const decideItem = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { item: await intake.decideItem(actorOf(req), req.params.itemId, req.body || {}) } });
});

export const execute = catchAsync(async (req, res) => {
  try {
    res.status(202).json({ status: "success", data: await intake.startExecute(actorOf(req), req.params.id, { revisions: req.body?.revisions || {} }) });
  } catch (err) {
    if (err.code === "STALE_CARD") return res.status(409).json({ status: "fail", code: err.code, message: err.message, itemIds: err.itemIds });
    throw err;
  }
});

export const listCreated = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { created: await intake.listCreated(actorOf(req), { companyId: req.query.companyId || null }) } });
});

// Express (urgent orders from the chat): what they made that nobody has checked yet, and "checked"
export const listExpress = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await intake.listExpressToReview(actorOf(req), { companyId: req.query.companyId || null }) });
});

export const markExpressReviewed = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await intake.markExpressReviewed(actorOf(req), req.body?.ids || []) });
});
