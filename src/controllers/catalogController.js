import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { prisma } from "../lib/prisma.js";
import { saveTempFile } from "../utils/fileHelper.js";
import { addCatalogJob } from "../lib/queue.js";

/**
 * Handle POST request for uploading PDF catalog and extracting products/categories
 */
export const uploadCatalog = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF file using the 'catalog' field!", 400));
  }

  const companyId = req.query.companyId || req.body.companyId || req.params.companyId;
  if (!companyId) {
    return next(new AppError("Company ID is required to associate the catalog products!", 400));
  }

  const brandId = req.query.brandId || req.body.brandId || null;

  // 1. Verify company exists (early validation)
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return next(new AppError("Target company not found!", 404));
  }

  // 2. Verify brand belongs to company if provided (early validation)
  if (brandId) {
    const brandExists = await prisma.brand.findFirst({
      where: { id: brandId, companyId },
    });
    if (!brandExists) {
      return next(new AppError("Selected brand not found or does not belong to this company!", 400));
    }
  }

  // 3. Save uploaded file to temp storage
  const filePath = saveTempFile(req.file.buffer, req.file.originalname);

  // 4. Create BackgroundTask in DB
  const task = await prisma.backgroundTask.create({
    data: {
      type: "catalog_upload",
      status: "pending",
      companyId: companyId,
      brandId: brandId,
    },
  });

  // 5. Queue the job in BullMQ
  await addCatalogJob(task.id, {
    companyId,
    filePath,
    fileName: req.file.originalname,
    brandId,
  });

  // 6. Return 202 Accepted immediately
  res.status(202).json({
    status: "accepted",
    message: "Catalog upload has been accepted and is processing in the background.",
    data: {
      jobId: task.id,
    },
  });
});

