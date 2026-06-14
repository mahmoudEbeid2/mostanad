import express from "express";
import {
  createCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createCategorySchema,
  updateCategorySchema,
  getCategoryByIdSchema,
  deleteCategorySchema,
} from "../validators/categoryValidator.js";

const router = express.Router();

router
  .route("/")
  .post(validate(createCategorySchema), createCategory)
  .get(getAllCategories);

router
  .route("/:id")
  .get(validate(getCategoryByIdSchema), getCategoryById)
  .patch(validate(updateCategorySchema), updateCategory)
  .delete(validate(deleteCategorySchema), deleteCategory);

export default router;
