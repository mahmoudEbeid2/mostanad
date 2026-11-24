import * as referenceLabelService from "../services/referenceLabelService.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { queueReferenceLabel, uploadedOn } from "../services/label/labelUploads.js";

const referenceLabelQueue = new Queue("referenceLabelQueue", { connection: getRedisConfig() });
const labelGeneratorQueue = new Queue("labelGeneratorQueue", { connection: getRedisConfig() });

export const generateLabelAi = catchAsync(async (req, res, next) => {
  const { productId, formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint } = req.body;

  if (!country || !language) {
    return next(new AppError("Please provide country and language", 400));
  }
  if (!productId && !formulationText) {
    return next(new AppError("Please provide productId or formulationText", 400));
  }

  // aimOfUse is confirmed, not guessed (Invariant #5's spirit) — either the user
  // states it here, or a referenced Product row already has it (checked below).
  let productHasConfirmedAimOfUse = false;
  if (productId) {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { indications: true } });
    productHasConfirmedAimOfUse = !!product?.indications?.trim();
  }
  if (!aimOfUseHint?.trim() && !productHasConfirmedAimOfUse) {
    return next(new AppError("Please provide the confirmed Aim of Use — the AI will not guess it — or reference a Product that already has one.", 400));
  }

  // GeneratedLabel.companyId is required (a label always belongs to a tenant — §5.1).
  // A company caller always generates under its own id. A system user (no req.company)
  // must say which company this label is for, the same explicit-companyId pattern
  // uploadReferenceLabels/createReferenceLabelManual already use.
  const companyId = req.company ? req.company.id : req.body.companyId;
  if (!companyId) {
    return next(new AppError("Please provide companyId — label generation must be scoped to a company.", 400));
  }

  // Create BackgroundTask
  const task = await prisma.backgroundTask.create({
    data: {
      type: "label_generation",
      status: "pending",
      companyId,
    },
  });

  // Add to Queue
  await labelGeneratorQueue.add(
    "generateLabel",
    {
      taskId: task.id,
      // Tenant scope for the reference-label lookup this job performs — a company
      // caller must only ever see its own + global references, never another
      // tenant's (see labelGeneratorWorker.js's referenceLabel.findMany). Also the
      // owning tenant for the persisted GeneratedLabel row (Phase 1, §5.1).
      companyId,
      // Whoever's token this request carries — a company's own id when called as a
      // tenant, or the real internal user id when called as a system user. Recorded
      // on GeneratedLabel.createdByUserId (§5.1) for audit/attribution.
      createdByUserId: req.user ? req.user.id : null,
      productId: productId || null,
      formulationText,
      country,
      language,
      // Optional expert-confirmed facts. When provided by the user, these
      // override AI guesswork/references entirely for these specific fields.
      aimOfUseHint: aimOfUseHint?.trim() || null,
      targetSpeciesHint: targetSpeciesHint?.trim() || null,
      directionOfUseHint: directionOfUseHint?.trim() || null,
    },
    { removeOnComplete: true, removeOnFail: true }
  );

  res.status(202).json({
    status: "success",
    message: "Label generation task queued successfully",
    data: { taskId: task.id },
  });
});

export const uploadReferenceLabels = catchAsync(async (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next(new AppError("Please upload at least one file.", 400));
  }
  
  const { companyId, brandId, country, categoryId, manualCategoryName } = req.body;

  if (!country?.trim()) {
    return next(new AppError("Please provide the country where this reference is accepted.", 400));
  }
  
  // A company caller always uploads into its own company. A system user names
  // the company, or sends an empty companyId for a global reference.
  const finalCompanyId = req.company ? req.company.id : companyId || null;
  
  const finalBrandId = brandId || null;
  const finalCategoryId = categoryId || null;

  // One result per file: queued, skipped (already a reference of this owner) or
  // failed (could not be queued). A failure on one file never hides the others.
  const tasks = [];
  const skipped = [];
  const failed = [];

  for (const file of req.files) {
    try {
      const queued = await queueReferenceLabel({ buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, country, companyId: finalCompanyId, brandId: finalBrandId, categoryId: finalCategoryId, manualCategoryName });
      if (queued.skipped) skipped.push({ fileName: file.originalname, existingId: queued.existing.id, uploadedAt: queued.existing.createdAt });
      else tasks.push({ taskId: queued.taskId, fileName: file.originalname });
    } catch (err) {
      console.error(`[ReferenceLabels] Could not queue ${file.originalname}:`, err);
      failed.push({ fileName: file.originalname, reason: err.message });
    }
  }

  const skippedText = skipped.map((s) => `${s.fileName} (already uploaded on ${uploadedOn(s.uploadedAt)})`).join(", ");
  const failedText = failed.map((f) => `${f.fileName} (${f.reason})`).join(", ");
  if (tasks.length === 0) {
    const parts = [skipped.length && `Skipped: ${skippedText}.`, failed.length && `Failed: ${failedText}.`].filter(Boolean);
    return next(new AppError(`No file was queued. ${parts.join(" ")}`, failed.length ? 500 : 400));
  }

  let message = `${tasks.length} reference(s) queued for AI analysis.`;
  if (skipped.length) message += ` Skipped: ${skippedText}.`;
  if (failed.length) message += ` Failed: ${failedText}.`;

  res.status(202).json({
    status: "success",
    message,
    data: { tasks, skipped, failed },
  });
});

export const retryReferenceLabelTask = catchAsync(async (req, res, next) => {
  const { taskId } = req.params;
  
  const job = await referenceLabelQueue.getJob(taskId);
  if (!job) {
    return next(new AppError("Background job not found or has expired from cache.", 404));
  }

  const state = await job.getState();
  if (state !== 'failed') {
    return next(new AppError(`Job is currently ${state}, cannot retry.`, 400));
  }

  await job.retry();
  
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: 'pending', error: null }
  });

  res.status(200).json({
    status: "success",
    message: "Task queued for retry."
  });
});

export const createReferenceLabelManual = catchAsync(async (req, res, next) => {
  const body = { ...req.body };

  if (req.company) {
    body.companyId = req.company.id;
  }

  const referenceLabel = await referenceLabelService.createManual(body);

  res.status(201).json({
    status: "success",
    data: {
      referenceLabel,
    },
  });
});

export const getAllReferenceLabels = catchAsync(async (req, res, next) => {
  const result = await referenceLabelService.getAll(req.query);
  res.status(200).json({
    status: "success",
    results: result.labels.length,
    total: result.total,
    data: {
      referenceLabels: result.labels,
    },
  });
});

export const getReferenceLabel = catchAsync(async (req, res, next) => {
  const label = await referenceLabelService.getById(req.params.id);
  res.status(200).json({
    status: "success",
    data: {
      referenceLabel: label,
    },
  });
});

export const deleteReferenceLabel = catchAsync(async (req, res, next) => {
  await referenceLabelService.deleteById(req.params.id);
  res.status(204).json({
    status: "success",
    data: null,
  });
});
