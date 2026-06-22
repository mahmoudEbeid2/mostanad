import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { verifyProductLabel } from "../services/labelService.js";

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

  const result = await verifyProductLabel(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    country
  );

  res.status(200).json({
    status: "success",
    message: "Label verified successfully!",
    data: result,
  });
});
