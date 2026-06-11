import express from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createProductSchema,
  updateProductSchema,
  getProductByIdSchema,
  deleteProductSchema,
} from "../validators/productValidator.js";

const router = express.Router();

// Scoped under companies
router.post(
  "/companies/:companyId/products",
  validate(createProductSchema),
  createProduct
);
router.get("/companies/:companyId/products", getAllProducts);

// Scoped under products
router
  .route("/products/:id")
  .get(validate(getProductByIdSchema), getProductById)
  .patch(validate(updateProductSchema), updateProduct)
  .delete(validate(deleteProductSchema), deleteProduct);

export default router;
