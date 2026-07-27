import * as edaRequirementService from "../services/edaRequirementService.js";
import catchAsync from "../utils/catchAsync.js";
// Trigger server restart after Prisma DB Push
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

const edaRequirementQueue = new Queue("edaRequirementQueue", { connection: getRedisConfig() });

export const uploadRequirement = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF or DOCX file.", 400));
  }
  
  const { country = "Egypt", companyId } = req.body;
  
  // If companyId is explicitly passed (even empty string for global), use it.
  // Otherwise, if the logged-in user is a company, use their ID.
  let finalCompanyId = null;
  if (companyId) {
    finalCompanyId = companyId;
  } else if (req.user && req.user.type === "company") {
    finalCompanyId = req.user.id;
  }

  // 1. Create a BackgroundTask record
  const task = await prisma.backgroundTask.create({
    data: {
      type: "eda_requirement_extraction",
      status: "pending",
      companyId: finalCompanyId,
    },
  });

  // 2. Add to Queue
  await edaRequirementQueue.add(
    "processEdaRequirement",
    {
      country,
      fileBufferBase64: req.file.buffer.toString("base64"),
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      companyId: finalCompanyId,
    },
    { jobId: task.id }
  );

  // 3. Return the jobId to the client instantly
  res.status(202).json({
    status: "success",
    message: "Document uploaded and queued for processing",
    data: { jobId: task.id }
  });
});

export const getRequirements = catchAsync(async (req, res, next) => {
  const { requirements, total } = await edaRequirementService.getAll(req.query);

  res.status(200).json({
    status: "success",
    results: requirements.length,
    total,
    data: requirements
  });
});

export const deleteRequirement = catchAsync(async (req, res, next) => {
  await edaRequirementService.remove(req.params.id);

  res.status(204).json({
    status: "success",
    data: null
  });
});

export const updateRequirement = catchAsync(async (req, res, next) => {
  const { country, extractedData } = req.body;
  const updatedReq = await edaRequirementService.update(req.params.id, {
    ...(country && { country }),
    ...(extractedData && { extractedData }),
  });
  
  res.status(200).json({
    status: "success",
    data: updatedReq,
  });
});
