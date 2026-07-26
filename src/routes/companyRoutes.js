import express from "express";
import {
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
  resetPassword,
} from "../controllers/companyController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import { uploadLogo } from "../middleware/uploadMiddleware.js";
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
  .post(
    restrictToPermission("create_companies"),
    uploadLogo.single("logo"),
    validate(createCompanySchema),
    createCompany
  )
  .get(restrictToPermission("read_companies"), getAllCompanies);

router
  .route("/:id")
  .get(restrictToPermission("read_companies"), validate(getCompanyByIdSchema), getCompanyById)
  .patch(
    restrictToPermission("update_companies"),
    uploadLogo.single("logo"),
    validate(updateCompanySchema),
    updateCompany
  )
  .delete(restrictToPermission("delete_companies"), validate(deleteCompanySchema), deleteCompany);

router
  .route("/:id/reset-password")
  .patch(restrictToPermission("update_companies"), resetPassword);

export default router;

