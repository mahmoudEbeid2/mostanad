import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { prisma } from "../lib/prisma.js";
import { saveTempFile } from "../utils/fileHelper.js";
import { addCertificateJob } from "../lib/queue.js";

/**
 * Endpoint using companyId from URL path parameters
 */
export const generateCertificates = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Invoice file is required!", 400));
  }

  const { companyId } = req.params;
  let brandId = req.body.brandId || null;
  if (brandId === "" || brandId === "null" || brandId === "undefined") {
    brandId = null;
  }
  const transactionType = req.body.transactionType;

  // 1. Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return next(new AppError("Target company not found!", 404));
  }

  // 2. Save file to temp storage
  const filePath = saveTempFile(req.file.buffer, req.file.originalname);

  // 3. Create BackgroundTask in DB
  const task = await prisma.backgroundTask.create({
    data: {
      type: "certificate_generation",
      status: "pending",
      companyId: companyId,
      brandId: brandId,
    },
  });

  // 4. Queue the job
  await addCertificateJob(task.id, {
    companyId,
    brandId,
    transactionType,
    filePath,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
  });

  // 5. Return 202 Accepted
  res.status(202).json({
    status: "accepted",
    message: "Certificate generation has been accepted and is processing in the background.",
    data: {
      jobId: task.id,
    },
  });
});

/**
 * Endpoint for authenticated companies where companyId is extracted from their session token
 */
export const generateCertificatesForCompanyToken = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Invoice file is required!", 400));
  }

  if (!req.company || !req.company.id) {
    return next(new AppError("Company authentication context is missing. Ensure you are logged in as a company.", 401));
  }

  const companyId = req.company.id;
  const brandId = req.body.brandId || null;
  const transactionType = req.body.transactionType;

  // 1. Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return next(new AppError("Target company not found!", 404));
  }

  // 2. Save file to temp storage
  const filePath = saveTempFile(req.file.buffer, req.file.originalname);

  // 3. Create BackgroundTask in DB
  const task = await prisma.backgroundTask.create({
    data: {
      type: "certificate_generation",
      status: "pending",
      companyId: companyId,
      brandId: brandId,
    },
  });

  // 4. Queue the job
  await addCertificateJob(task.id, {
    companyId,
    brandId,
    transactionType,
    filePath,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
  });

  // 5. Return 202 Accepted
  res.status(202).json({
    status: "accepted",
    message: "Certificate generation has been accepted and is processing in the background.",
    data: {
      jobId: task.id,
    },
  });
});

