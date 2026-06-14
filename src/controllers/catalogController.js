import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { processCatalogPDF } from "../services/catalogService.js";

/**
 * Handle POST request for uploading PDF catalog and extracting products/categories
 */
export const uploadCatalog = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF file using the 'catalog' field!", 400));
  }

  const companyId = req.params.companyId || req.body.companyId;
  if (!companyId) {
    return next(new AppError("Company ID is required to associate the catalog products!", 400));
  }

  const brandId = req.body.brandId || req.query.brandId;

  const result = await processCatalogPDF(companyId, req.file.buffer, req.file.originalname, brandId);

  res.status(201).json({
    status: "success",
    message: "Catalog processed and products extracted successfully!",
    data: result,
  });
});
