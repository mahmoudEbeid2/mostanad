import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { prisma } from "../lib/prisma.js";
import { saveTempFile } from "../utils/fileHelper.js";
import { addLabelJob } from "../lib/queue.js";

/**
 * POST /products/verify-label
 * Upload a PDF or image label and verify compliance against country regulations.
 * Searches globally across all products in the DB — no company scope needed.
 */
export const verifyLabel = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF or image file using the 'label' field!", 400));
  }

  const country = req.body.country || req.query.country;
  if (!country) {
    return next(new AppError("Target country is required!", 400));
  }

  const companyId = req.query.companyId || req.body.companyId || (req.company && req.company.id) || null;

  // 1. Save uploaded file to temp storage
  const filePath = saveTempFile(req.file.buffer, req.file.originalname);

  // 2. Create BackgroundTask in DB
  const task = await prisma.backgroundTask.create({
    data: {
      type: "label_verification",
      status: "pending",
      companyId: companyId,
    },
  });

  // 3. Queue the job in BullMQ
  await addLabelJob(task.id, {
    filePath,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    country,
    companyId,
  });

  // 4. Return 202 Accepted immediately
  res.status(202).json({
    status: "accepted",
    message: "Label verification has been accepted and is processing in the background.",
    data: {
      jobId: task.id,
    },
  });
});

