import express from "express";
import {
  createCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import {
  createCategorySchema,
  updateCategorySchema,
  getCategoryByIdSchema,
  deleteCategorySchema,
} from "../validators/categoryValidator.js";

const router = express.Router();

router
  .route("/")
  .post(restrictToPermission("create_categories"), validate(createCategorySchema), createCategory)
  .get(restrictToPermission("read_categories"), getAllCategories);

router
  .route("/:id")
  .get(restrictToPermission("read_categories"), validate(getCategoryByIdSchema), getCategoryById)
  .patch(restrictToPermission("update_categories"), validate(updateCategorySchema), updateCategory)
  .delete(restrictToPermission("delete_categories"), validate(deleteCategorySchema), deleteCategory);

export default router;
