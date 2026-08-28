import express from "express";
import { uploadDocument, getDocuments, getDocument, compileRules, auditCoverage, approveDocument, markClauseNonNormative } from "../controllers/regulatoryDocumentController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", restrictToPermission("read_regulatory"), getDocuments);
router.post("/", restrictToPermission("create_regulatory"), upload.single("file"), uploadDocument);
router.get("/:id", restrictToPermission("read_regulatory"), getDocument);
router.post("/:id/compile-rules", restrictToPermission("approve_regulatory"), compileRules);
router.post("/:id/audit-coverage", restrictToPermission("approve_regulatory"), auditCoverage);
router.post("/:id/approve", restrictToPermission("approve_regulatory"), approveDocument);
router.patch("/:id/clauses/clear", restrictToPermission("approve_regulatory"), markClauseNonNormative);

export default router;
