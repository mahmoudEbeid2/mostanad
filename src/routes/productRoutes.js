import express from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";
import { verifyLabel } from "../controllers/labelController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { uploadLabel } from "../middleware/uploadMiddleware.js";
import {
  createProductSchema,
  updateProductSchema,
  getProductByIdSchema,
  deleteProductSchema,
} from "../validators/productValidator.js";
import { verifyLabelSchema } from "../validators/labelValidator.js";

const router = express.Router();

// Scoped under companies
router.post(
  "/companies/:companyId/products",
  validate(createProductSchema),
  createProduct
);
router.get("/companies/:companyId/products", getAllProducts);

// Label AI verification — global, no company scope
// POST /products/verify-label  (multipart: label file + country in body)
router.post(
  "/products/verify-label",
  uploadLabel.single("label"),
  validate(verifyLabelSchema),
  verifyLabel
);

// Scoped under products
router
  .route("/products/:id")
  .get(validate(getProductByIdSchema), getProductById)
  .patch(validate(updateProductSchema), updateProduct)
  .delete(validate(deleteProductSchema), deleteProduct);

export default router;
