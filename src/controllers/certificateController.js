import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { generateCertificatesAndPopulateTemplates } from "../services/certificateService.js";

/**
 * Endpoint using companyId from URL path parameters
 */
export const generateCertificates = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Invoice file is required!", 400));
  }

  const { companyId } = req.params;
  const { brandId, transactionType } = req.body;

  const result = await generateCertificatesAndPopulateTemplates(
    companyId,
    brandId || null,
    transactionType,
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype
  );

  res.status(200).json({
    status: "success",
    data: result,
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
  const { brandId, transactionType } = req.body;

  const result = await generateCertificatesAndPopulateTemplates(
    companyId,
    brandId || null,
    transactionType,
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype
  );

  res.status(200).json({
    status: "success",
    data: result,
  });
});
