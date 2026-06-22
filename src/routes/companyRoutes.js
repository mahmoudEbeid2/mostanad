import express from "express";
import {
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
} from "../controllers/companyController.js";
import { uploadCatalog } from "../controllers/catalogController.js";
import { upload } from "../middleware/uploadMiddleware.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createCompanySchema,
  updateCompanySchema,
  getCompanyByIdSchema,
  deleteCompanySchema,
} from "../validators/companyValidator.js";

import { protect } from "../middleware/authMiddleware.js";
import { companyLogin } from "../controllers/authController.js";
import { loginSchema } from "../validators/authValidator.js";

const router = express.Router();

// Public route for company login
router.post("/login", validate(loginSchema), companyLogin);

// Protect all other company routes
router.use(protect);

router
  .route("/")
  .post(validate(createCompanySchema), createCompany)
  .get(getAllCompanies);

router
  .route("/:id")
  .get(validate(getCompanyByIdSchema), getCompanyById)
  .patch(validate(updateCompanySchema), updateCompany)
  .delete(validate(deleteCompanySchema), deleteCompany);

// PDF Catalog product extraction route
router.post(
  "/:companyId/products/upload-catalog",
  upload.single("catalog"),
  uploadCatalog
);

export default router;

