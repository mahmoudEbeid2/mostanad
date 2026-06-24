import express from "express";
import {
  createTemplate,
  getAllTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from "../controllers/templateController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
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
  restrictToPermission("create_templates"),
  validate(createTemplateSchema),
  createTemplate
);
router.get("/companies/:companyId/templates", restrictToPermission("read_templates"), getAllTemplates);

// Scoped under templates
router
  .route("/templates/:id")
  .get(restrictToPermission("read_templates"), validate(getTemplateByIdSchema), getTemplateById)
  .patch(restrictToPermission("update_templates"), validate(updateTemplateSchema), updateTemplate)
  .delete(restrictToPermission("delete_templates"), validate(deleteTemplateSchema), deleteTemplate);

export default router;
