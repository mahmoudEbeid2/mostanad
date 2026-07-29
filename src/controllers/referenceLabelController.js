import * as referenceLabelService from "../services/referenceLabelService.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

const referenceLabelQueue = new Queue("referenceLabelQueue", { connection: getRedisConfig() });
const labelGeneratorQueue = new Queue("labelGeneratorQueue", { connection: getRedisConfig() });

export const generateLabelAi = catchAsync(async (req, res, next) => {
  const { formulationText, country, language } = req.body;

  if (!formulationText || !country || !language) {
    return next(new AppError("Please provide formulationText, country, and language", 400));
  }

  // Create BackgroundTask
  const task = await prisma.backgroundTask.create({
    data: {
      type: "label_generation",
      status: "pending",
    },
  });

  // Add to Queue
  await labelGeneratorQueue.add(
    "generateLabel",
    {
      taskId: task.id,
      formulationText,
      country,
      language
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
