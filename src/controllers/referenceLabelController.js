import * as referenceLabelService from "../services/referenceLabelService.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

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
  
  // If companyId is explicitly passed (even empty string for global), use it.
  // Otherwise, if the logged-in user is a company, use their ID.
  let finalCompanyId = null;
  if (companyId !== undefined) {
    finalCompanyId = companyId || null;
  } else if (req.company) {
    finalCompanyId = req.company.id;
  }
  
  const finalBrandId = brandId || null;
  const finalCategoryId = categoryId || null;

  const tasks = [];
  let skippedCount = 0;

  for (const file of req.files) {
    // Check if reference label with same name exists
    const existingLabel = await prisma.referenceLabel.findFirst({
      where: { name: file.originalname }
    });

    if (existingLabel) {
      console.log(`[ReferenceLabelController] Skipping ${file.originalname}, already exists.`);
      skippedCount++;
      continue;
    }

    // 1. Create a BackgroundTask record
    const task = await prisma.backgroundTask.create({
      data: {
        type: "reference_label_extraction",
        status: "pending",
        companyId: finalCompanyId,
        brandId: finalBrandId,
      },
    });

    // 2. Add to Queue
    await referenceLabelQueue.add(
      "processReferenceLabel",
      {
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileBufferBase64: file.buffer.toString("base64"),
        taskId: task.id,
        companyId: finalCompanyId,
        brandId: finalBrandId,
        country: country.trim(),
        categoryId: finalCategoryId,
        manualCategoryName: manualCategoryName?.trim() || null,
      },
      {
        jobId: task.id, 
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 4,
        backoff: {
          type: 'exponential',
          delay: 15000 // 15 seconds initial delay
        }
      }
    );

    tasks.push({
      taskId: task.id,
      fileName: file.originalname,
    });
  }

  if (tasks.length === 0) {
    return next(new AppError(`All ${skippedCount} uploaded files already exist in the system.`, 400));
  }

  let message = `${tasks.length} reference(s) queued for AI analysis.`;
  if (skippedCount > 0) {
    message += ` Skipped ${skippedCount} duplicate(s).`;
  }

  res.status(202).json({
    status: "success",
    message,
    data: {
      tasks,
    },
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
