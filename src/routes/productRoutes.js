import express from "express";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  extractProductAi,
  getCopyFields,
  copyProduct,
  copyProductsBulkCtrl,
  getSourceDiff,
  updateFromSourceCtrl,
} from "../controllers/productController.js";
import { verifyLabel } from "../controllers/labelController.js";
import { uploadCatalog } from "../controllers/catalogController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import { uploadLabel, upload } from "../middleware/uploadMiddleware.js";
import {
  createProductSchema,
  updateProductSchema,
  getProductByIdSchema,
  deleteProductSchema,
  copyProductSchema,
  copyProductsBulkSchema,
  updateFromSourceSchema,
} from "../validators/productValidator.js";
import { verifyLabelSchema } from "../validators/labelValidator.js";

const router = express.Router();

// Global product routes
router.post(
  "/products",
  restrictToPermission("create_products"),
  validate(createProductSchema),
  createProduct
);
router.get("/products", restrictToPermission("read_products"), getAllProducts);

router.post(
  "/products/extract-ai",
  restrictToPermission("create_products"),
  extractProductAi
);

// PDF Catalog product extraction route
router.post(
  "/products/upload-catalog",
  restrictToPermission("create_products"),
  upload.single("catalog"),
  uploadCatalog
);

// Label AI verification — global, no company scope
// POST /products/verify-label  (multipart: label file + country in body)
router.post(
  "/products/verify-label",
  restrictToPermission("read_products"),
  uploadLabel.single("label"),
  validate(verifyLabelSchema),
  verifyLabel
);

// Copy to another brand (same product data under another brand's name)
router.get("/products/copy-fields", restrictToPermission("read_products"), getCopyFields);
router.post("/products/copy-bulk", restrictToPermission("create_products"), validate(copyProductsBulkSchema), copyProductsBulkCtrl);
router.post("/products/:id/copy", restrictToPermission("create_products"), validate(copyProductSchema), copyProduct);
router.get("/products/:id/source-diff", restrictToPermission("read_products"), validate(getProductByIdSchema), getSourceDiff);
router.post("/products/:id/update-from-source", restrictToPermission("update_products"), validate(updateFromSourceSchema), updateFromSourceCtrl);

// Scoped under products
router
  .route("/products/:id")
  .get(restrictToPermission("read_products"), validate(getProductByIdSchema), getProductById)
  .patch(restrictToPermission("update_products"), validate(updateProductSchema), updateProduct)
  .delete(restrictToPermission("delete_products"), validate(deleteProductSchema), deleteProduct);

export default router;
