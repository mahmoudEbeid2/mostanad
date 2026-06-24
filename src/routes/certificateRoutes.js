import express from "express";
import { 
  generateCertificates, 
  generateCertificatesForCompanyToken 
} from "../controllers/certificateController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { generateCertificatesSchema } from "../validators/certificateValidator.js";
import { uploadLabel } from "../middleware/uploadMiddleware.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

// General endpoint specifying companyId in URL path
router.post(
  "/companies/:companyId/certificates/generate",
  restrictToPermission("create_certificates"),
  uploadLabel.single("invoice"),
  validate(generateCertificatesSchema),
  generateCertificates
);

// Token-scoped endpoint extracting companyId from authenticated company context
router.post(
  "/certificates/generate",
  protect,
  restrictToPermission("create_certificates"),
  uploadLabel.single("invoice"),
  validate(generateCertificatesSchema),
  generateCertificatesForCompanyToken
);

export default router;
