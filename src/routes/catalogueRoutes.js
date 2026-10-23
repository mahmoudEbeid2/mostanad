import express from "express";
import multer from "multer";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { validateRequest as validate } from "../middleware/certificatesValidate.js";
import { CertError } from "../services/certificates/errors.js";
import { MAX_CATALOGUE_BYTES } from "../services/catalogues/catalogueService.js";
import { catalogueSchemas } from "../validators/catalogueValidator.js";
import * as catalogues from "../controllers/catalogueController.js";

// Product catalogues (plan.md §15, A6). Every route: protect + restrictToPermission
// + tenant scoping in the service (another tenant's row → 404).
//  - manage_catalogues (system users only — its module is not company-allowed):
//    upload, new version, linking a block to a product
//  - read_products: a company views and searches its own catalogues
const router = express.Router();
const guard = (permission) => [protect, restrictToPermission(permission)];
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CATALOGUE_BYTES, files: 1 } });

router.post("/catalogues", guard("manage_catalogues"), uploadPdf.single("file"), validate(catalogueSchemas.upload), catalogues.uploadCatalogue);
router.get("/catalogues", guard("read_products"), validate(catalogueSchemas.list), catalogues.listCatalogues);
// A6.6: full text + fuzzy names over the company's catalogue blocks
router.get("/catalogue-search", guard("read_products"), validate(catalogueSchemas.search), catalogues.search);
router.get("/catalogues/:id", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getCatalogue);
router.post("/catalogues/:id/versions", guard("manage_catalogues"), uploadPdf.single("file"), validate(catalogueSchemas.uploadVersion), catalogues.uploadVersion);
router.get("/catalogue-versions/:id", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getVersion);
router.get("/catalogue-versions/:id/file", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getVersionFile);
router.get("/catalogue-blocks/:id", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getBlock);
router.post("/catalogue-blocks/:id/link", guard("manage_catalogues"), validate(catalogueSchemas.link), catalogues.linkBlock);
// A6.3: AI extraction (CATALOGUE_EXTRACT + CATALOGUE_INFER) and the once-per-catalogue number convention
router.post("/catalogue-versions/:id/extract", guard("manage_catalogues"), validate(catalogueSchemas.extract), catalogues.extractVersion);
router.put("/catalogue-versions/:id/number-convention", guard("manage_catalogues"), validate(catalogueSchemas.convention), catalogues.putNumberConvention);
// A6.4: review — accept creates a product (never updates one: that is the §15.4 diff), bulk accept, segmentation fixes
router.get("/catalogue-versions/:id/review", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getReview);
router.post("/catalogue-versions/:id/accept-unflagged", guard("manage_catalogues"), validate(catalogueSchemas.decide), catalogues.acceptUnflagged);
router.post("/catalogue-versions/:id/merge-blocks", guard("manage_catalogues"), validate(catalogueSchemas.merge), catalogues.mergeBlocks);
router.patch("/catalogue-blocks/:id", guard("manage_catalogues"), validate(catalogueSchemas.editBlock), catalogues.editBlock);
router.post("/catalogue-blocks/:id/accept", guard("manage_catalogues"), validate(catalogueSchemas.decide), catalogues.acceptBlock);
router.post("/catalogue-blocks/:id/reject", guard("manage_catalogues"), validate(catalogueSchemas.decide), catalogues.rejectBlock);
router.post("/catalogue-blocks/:id/split", guard("manage_catalogues"), validate(catalogueSchemas.split), catalogues.splitBlock);
// A6.5: re-upload diff — existing products change only here, per product or per field
router.get("/catalogue-versions/:id/diff", guard("read_products"), validate(catalogueSchemas.byId), catalogues.getDiff);
router.post("/catalogue-versions/:id/apply-diff", guard("manage_catalogues"), validate(catalogueSchemas.decide), catalogues.applyVersionDiff);
router.post("/catalogue-blocks/:id/apply-diff", guard("manage_catalogues"), validate(catalogueSchemas.applyDiff), catalogues.applyBlockDiff);

// Coded errors: { status, code, message, ...extra } (same contract as the certificates router).
router.use((err, req, res, next) => {
  if (err instanceof CertError) {
    return res.status(err.statusCode).json({ status: err.status, code: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({ status: "fail", code: tooLarge ? "FILE_TOO_LARGE" : err.code, message: tooLarge ? "The uploaded file is too large" : err.message });
  }
  next(err);
});

export default router;
