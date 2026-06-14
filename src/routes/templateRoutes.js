import express from "express";
import {
  createTemplate,
  getAllTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from "../controllers/templateController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createTemplateSchema,
  updateTemplateSchema,
  getTemplateByIdSchema,
  deleteTemplateSchema,
} from "../validators/templateValidator.js";

const router = express.Router();

// Scoped under companies
router.post(
  "/companies/:companyId/templates",
  validate(createTemplateSchema),
  createTemplate
);
router.get("/companies/:companyId/templates", getAllTemplates);

// Scoped under templates
router
  .route("/templates/:id")
  .get(validate(getTemplateByIdSchema), getTemplateById)
  .patch(validate(updateTemplateSchema), updateTemplate)
  .delete(validate(deleteTemplateSchema), deleteTemplate);

export default router;
