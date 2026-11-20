import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { prisma } from "../lib/prisma.js";
import { startLabelVerification } from "../services/label/labelUploads.js";

/**
 * POST /products/verify-label
 * Upload a PDF or image label and verify compliance against country regulations.
 * Product matching (§14.5.1) is tenant-scoped: a company caller always matches
 * against its own products, never a caller-supplied companyId — otherwise any
 * authenticated company could point this endpoint at another tenant's catalog.
 */
export const verifyLabel = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF or image file using the 'label' field!", 400));
  }

  const country = req.body.country || req.query.country;
  if (!country) {
    return next(new AppError("Target country is required!", 400));
  }

  const companyId = req.company ? req.company.id : (req.query.companyId || req.body.companyId || null);

  const { taskId } = await startLabelVerification({ buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype, country, companyId });

  // 4. Return 202 Accepted immediately
  res.status(202).json({
    status: "accepted",
    message: "Label verification has been accepted and is processing in the background.",
    data: {
      jobId: taskId,
    },
  });
});

