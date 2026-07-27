import * as referenceLabelService from "../services/referenceLabelService.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

const referenceLabelQueue = new Queue("referenceLabelQueue", { connection: getRedisConfig() });

export const uploadReferenceLabels = catchAsync(async (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next(new AppError("Please upload at least one file.", 400));
  }
  
  const { companyId } = req.body;
  
  // If companyId is explicitly passed (even empty string for global), use it.
  // Otherwise, if the logged-in user is a company, use their ID.
  let finalCompanyId = null;
  if (companyId !== undefined) {
    finalCompanyId = companyId || null;
  } else if (req.user && req.user.type === "company") {
    finalCompanyId = req.user.id;
  }

  const tasks = [];

  for (const file of req.files) {
    // 1. Create a BackgroundTask record
    const task = await prisma.backgroundTask.create({
      data: {
        type: "reference_label_extraction",
        status: "pending",
        companyId: finalCompanyId,
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

  res.status(202).json({
    status: "success",
    message: "Reference labels uploaded and queued for AI extraction.",
    data: {
      tasks,
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
