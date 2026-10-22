import express from "express";
import multer from "multer";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { validateRequest as validate } from "../middleware/certificatesValidate.js";
import { CertError } from "../services/certificates/errors.js";
import { MAX_TEMPLATE_BYTES } from "../services/certificates/templates/templateService.js";
import { typeSchemas, templateSchemas, versionSchemas, productSearchSchema, invoiceSchemas, certificateSchemas, aiSchemas, mappingSchemas } from "../validators/certificatesV2Validator.js";
import * as types from "../controllers/certificatesV2/certificateTypeController.js";
import * as templates from "../controllers/certificatesV2/certificateTemplateController.js";
import * as invoices from "../controllers/certificatesV2/invoiceController.js";
import * as certificates from "../controllers/certificatesV2/certificateController.js";
import * as certificateAi from "../controllers/certificatesV2/certificateAiController.js";
import { MAX_INVOICE_BYTES } from "../services/certificates/invoices/invoiceService.js";

// Certificates V2 API (CERTIFICATES_V2_PLAN.md §12). Every route: protect +
// restrictToPermission + tenant scoping in the service (cross-tenant → 404).
const router = express.Router();
const guard = (permission) => [protect, restrictToPermission(permission)];

// Template designs: extension + magic bytes are checked in the service (an .ai
// arrives with arbitrary mime types), so no mime filter here.
const uploadTemplate = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1 } });

// ── certificate types ────────────────────────────────────────────────────────
router.get("/certificate-types", guard("read_certificate_types"), validate(typeSchemas.list), types.listTypes);
router.post("/certificate-types", guard("create_certificate_types"), validate(typeSchemas.create), types.createType);
router.patch("/certificate-types/:id", guard("update_certificate_types"), validate(typeSchemas.update), types.updateType);
router.delete("/certificate-types/:id", guard("delete_certificate_types"), validate(typeSchemas.byId), types.deleteType);

// ── templates ────────────────────────────────────────────────────────────────
router.post(
  "/certificate-templates",
  guard("create_certificate_templates"),
  uploadTemplate.single("file"),
  validate(templateSchemas.create),
  templates.createTemplate
);
router.get("/certificate-templates", guard("read_certificate_templates"), validate(templateSchemas.list), templates.listTemplates);
router.get("/certificate-templates/:id", guard("read_certificate_templates"), validate(templateSchemas.byId), templates.getTemplate);
router.patch("/certificate-templates/:id", guard("update_certificate_templates"), validate(templateSchemas.update), templates.updateTemplate);
router.post(
  "/certificate-templates/:id/versions",
  guard("update_certificate_templates"),
  uploadTemplate.single("file"),
  validate(templateSchemas.byId),
  templates.uploadVersion
);
router.post("/certificate-templates/:id/archive", guard("update_certificate_templates"), validate(templateSchemas.byId), templates.archiveTemplate);

// ── template versions ───────────────────────────────────────────────────────
router.get("/template-versions/:id", guard("read_certificate_templates"), validate(versionSchemas.byId), templates.getVersion);
router.get("/template-versions/:id/html", guard("read_certificate_templates"), validate(versionSchemas.html), templates.getVersionHtml);
router.get("/template-versions/:id/thumbnail", guard("read_certificate_templates"), validate(versionSchemas.byId), templates.getThumbnail);
router.put("/template-versions/:id/fields", guard("update_certificate_templates"), validate(versionSchemas.fields), templates.putFields);
router.post("/template-versions/:id/fields/confirm", guard("update_certificate_templates"), validate(versionSchemas.confirm), templates.confirmFields);
// AI plan §5 (A1): label proposals (code), field mapping (memory → dictionary → one AI call), the "Why?" of a suggestion
router.post("/template-versions/:id/label-proposals", guard("update_certificate_templates"), validate(mappingSchemas.labelProposals), certificateAi.labelProposals);
router.post("/template-versions/:id/map-fields", guard("update_certificate_templates"), validate(mappingSchemas.mapFields), certificateAi.mapFields);
router.get("/ai-suggestions/:id", guard("read_certificate_templates"), validate(mappingSchemas.suggestion), certificateAi.getSuggestion);
router.post("/template-versions/:id/suggest", guard("update_certificate_templates"), validate(versionSchemas.byId), templates.suggestFields);
router.post("/template-versions/:id/prepare", guard("update_certificate_templates"), validate(versionSchemas.byId), templates.prepareVersion);
router.get("/template-versions/:id/prepare-diff", guard("read_certificate_templates"), validate(versionSchemas.diff), templates.getPrepareDiff);
router.post("/template-versions/:id/preview", guard("read_certificate_templates"), validate(versionSchemas.preview), templates.previewVersion);
router.post("/template-versions/:id/activate", guard("update_certificate_templates"), validate(versionSchemas.byId), templates.activateVersion);
router.post("/template-versions/:id/new-version", guard("update_certificate_templates"), validate(versionSchemas.byId), templates.newVersion);
router.post("/template-versions/:id/enable-groups", guard("update_certificate_templates"), validate(versionSchemas.byId), templates.enableGroups);
router.get("/certificate-field-sources", guard("read_certificate_templates"), validate(aiSchemas.company), templates.getFieldSources);

// ── certificate AI layers — foundations (plan.md §3, Phase A0) ──────────────
router.get("/certificate-data-dictionary", guard("read_certificate_templates"), validate(aiSchemas.company), certificateAi.getDataDictionary);
router.post("/certificate-data-dictionary/rebuild", guard("update_certificate_templates"), validate(aiSchemas.company), certificateAi.rebuildDataDictionary);
router.get("/certificate-ai-settings", guard("read_certificate_templates"), validate(aiSchemas.company), certificateAi.getSettings);
router.patch("/certificate-ai-settings", guard("update_certificate_templates"), validate(aiSchemas.updateSettings), certificateAi.updateSettings);
router.get("/certificate-products", guard("read_products"), validate(productSearchSchema), templates.productSearch);

// ── invoices (§9) ────────────────────────────────────────────────────────────
// Type is decided by magic bytes in the service; multer only bounds the size.
const uploadInvoice = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_INVOICE_BYTES, files: 1 } });
router.post("/invoices", guard("create_invoices"), uploadInvoice.single("invoice"), validate(invoiceSchemas.upload), invoices.uploadInvoice);
router.get("/invoices", guard("read_invoices"), validate(invoiceSchemas.list), invoices.listInvoices);
router.get("/invoices/:id", guard("read_invoices"), validate(invoiceSchemas.byId), invoices.getInvoice);
router.get("/invoices/:id/source", guard("read_invoices"), validate(invoiceSchemas.byId), invoices.getSource);
router.patch("/invoices/:id", guard("update_invoices"), validate(invoiceSchemas.update), invoices.updateInvoice);
router.post("/invoices/:id/items", guard("update_invoices"), validate(invoiceSchemas.addItem), invoices.addItem);
router.patch("/invoices/:id/items/:itemId", guard("update_invoices"), validate(invoiceSchemas.updateItem), invoices.updateItem);
router.delete("/invoices/:id/items/:itemId", guard("update_invoices"), validate(invoiceSchemas.itemById), invoices.deleteItem);
router.post("/invoices/:id/rematch", guard("update_invoices"), validate(invoiceSchemas.byId), invoices.rematch);
router.post("/invoices/:id/confirm", guard("update_invoices"), validate(invoiceSchemas.byId), invoices.confirmInvoice);
router.post("/invoices/:id/retry", guard("update_invoices"), validate(invoiceSchemas.byId), invoices.retryExtraction); // plan §20 I17

// ── generation + generated certificates (§10–§12) ───────────────────────────
router.get("/invoices/:id/generation-plan", guard("read_invoices"), validate(invoiceSchemas.byId), certificates.generationPlan); // plan §20 I19
router.post("/invoices/:id/generate", guard("create_certificates"), validate(invoiceSchemas.byId), certificates.generate);
router.get("/certificate-batches/:id", guard("read_certificates"), validate(certificateSchemas.byId), certificates.getBatch);
router.get("/certificates", guard("read_certificates"), validate(certificateSchemas.list), certificates.listCertificates);
router.get("/certificates/:id", guard("read_certificates"), validate(certificateSchemas.byId), certificates.getCertificate);
router.get("/certificates/:id/html", guard("read_certificates"), validate(certificateSchemas.html), certificates.getCertificateHtml);
router.get("/certificates/:id/thumbnail", guard("read_certificates"), validate(certificateSchemas.byId), certificates.getCertificateThumbnail);
router.patch("/certificates/:id/values", guard("update_certificates"), validate(certificateSchemas.values), certificates.editValues);
router.post("/certificates/:id/fields/:key/reset", guard("update_certificates"), validate(certificateSchemas.field), certificates.resetField);
router.get("/certificates/:id/versions", guard("read_certificates"), validate(certificateSchemas.byId), certificates.listVersions);
router.post("/certificates/:id/versions/:n/restore", guard("update_certificates"), validate(certificateSchemas.restore), certificates.restoreVersion);
router.post("/certificates/:id/export-pdf", guard("export_certificates"), validate(certificateSchemas.byId), certificates.exportPdf);
router.get("/certificates/:id/pdf", guard("export_certificates"), validate(certificateSchemas.html), certificates.getPdf);
router.post("/certificates/:id/finalize", guard("update_certificates"), validate(certificateSchemas.action), certificates.finalize);
router.post("/certificates/:id/duplicate", guard("update_certificates"), validate(certificateSchemas.byId), certificates.duplicate);
router.post("/certificate-batches/:id/export", guard("export_certificates"), validate(certificateSchemas.byId), certificates.exportZip);
router.get("/certificate-batches/:id/zip", guard("export_certificates"), validate(certificateSchemas.byId), certificates.getZip); // plan §20 I21
router.get("/certificate-metrics", guard("read_certificates"), validate(certificateSchemas.metrics), certificates.metrics); // plan §15, §20 I23

// Coded errors (plan §20 I3): { status, code, message, ...extra }. Everything
// else falls through to the global handler unchanged.
router.use((err, req, res, next) => {
  if (err instanceof CertError) {
    return res.status(err.statusCode).json({ status: err.status, code: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      status: "fail",
      code: tooLarge ? "FILE_TOO_LARGE" : err.code,
      message: tooLarge ? "The uploaded file is too large" : err.message,
    });
  }
  next(err);
});

export default router;
