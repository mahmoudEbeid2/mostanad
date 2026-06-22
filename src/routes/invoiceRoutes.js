import express from "express";
import { extractInvoice } from "../controllers/invoiceController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { extractInvoiceSchema } from "../validators/invoiceValidator.js";
import { uploadLabel } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.post(
  "/companies/:companyId/invoices/extract",
  uploadLabel.single("invoice"),
  validate(extractInvoiceSchema),
  extractInvoice
);

export default router;
