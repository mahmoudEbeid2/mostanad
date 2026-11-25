import express from "express";
import multer from "multer";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { MAX_FILES } from "../services/catalogues/productImportService.js";
import * as c from "../controllers/productImportController.js";

// Products from many files at once (labels, product sheets, Excel/CSV, a pasted list) →
// one table → "save all". protect + permission on every route; tenant scope in the service.
const router = express.Router();
const guard = (permission) => [protect, restrictToPermission(permission)];
const files = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: MAX_FILES } });

router.post("/product-imports", guard("create_products"), files.array("files", MAX_FILES), c.postImport);
router.get("/product-imports", guard("read_products"), c.listImports);
router.get("/product-imports/:id", guard("read_products"), c.getImport);
router.patch("/product-imports/:id/rows/:rowId", guard("create_products"), c.patchRow);
router.post("/product-imports/:id/rows/:rowId/skip", guard("create_products"), c.skipRow);
router.post("/product-imports/:id/save-all", guard("create_products"), c.saveAll);

export default router;
