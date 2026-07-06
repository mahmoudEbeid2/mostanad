import catchAsync from "../utils/catchAsync.js";
import {
  createTemplate as createTemplateService,
  getAllTemplates as getAllTemplatesService,
  getTemplateById as getTemplateByIdService,
  updateTemplate as updateTemplateService,
  deleteTemplate as deleteTemplateService,
} from "../services/templateService.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import fs from "fs";
import path from "path";

const aiTemplateQueue = new Queue("aiTemplateQueue", { connection: getRedisConfig() });

// 1. CREATE TEMPLATE
export const createTemplate = catchAsync(async (req, res, next) => {
  const template = await createTemplateService(req.params.companyId, req.body);
  res.status(201).json({ status: "success", data: { template } });
});

// 2. GET ALL TEMPLATES
export const getAllTemplates = catchAsync(async (req, res, next) => {
  const { meta, templates } = await getAllTemplatesService(req.params.companyId, req.query);
  res.status(200).json({ status: "success", meta, data: { templates } });
});

// 3. GET TEMPLATE BY ID
export const getTemplateById = catchAsync(async (req, res, next) => {
  const template = await getTemplateByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { template } });
});

// 4. UPDATE TEMPLATE
export const updateTemplate = catchAsync(async (req, res, next) => {
  const template = await updateTemplateService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { template } });
});

// 5. DELETE TEMPLATE
export const deleteTemplate = catchAsync(async (req, res, next) => {
  await deleteTemplateService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});

// 6. GENERATE TEMPLATE VIA AI
export const generateTemplateViaAI = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a design file (.ai, .pdf, .png, .jpg)", 400));
  }

  const { brandId, templateName } = req.body;
  const companyId = req.params.companyId;

  // Create background task
  const task = await prisma.backgroundTask.create({
    data: {
      type: "ai_template_generation",
      status: "pending",
      companyId: companyId,
    },
  });

  // Add to queue
  await aiTemplateQueue.add(
    "generateAITemplate",
    {
      companyId,
      brandId,
      templateName,
      fileBufferBase64: req.file.buffer.toString('base64'),
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    },
    { jobId: task.id }
  );

  res.status(202).json({
    status: "success",
    message: "AI Template Generation task queued successfully",
    data: { taskId: task.id },
  });
});
