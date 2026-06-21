import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { verifyProductLabel } from "../services/labelService.js";

/**
 * Handle POST request for uploading a PDF or image label and verifying compliance against country guidelines.
 */
export const verifyLabel = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Please upload a PDF or image file using the 'label' field!", 400));
  }

  const companyId = req.params.companyId || req.body.companyId || req.query.companyId || null;

  const country = req.body.country || req.query.country;
  if (!country) {
    return next(new AppError("Target country is required!", 400));
  }

  const result = await verifyProductLabel(
    companyId,
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
