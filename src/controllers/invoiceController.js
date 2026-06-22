import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { extractInvoiceAndPopulateTemplates } from "../services/invoiceService.js";

export const extractInvoice = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Invoice file is required!", 400));
  }

  const { companyId } = req.params;
  const { brandId, transactionType } = req.body;

  const result = await extractInvoiceAndPopulateTemplates(
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
