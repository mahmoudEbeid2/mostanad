import express from "express";
import * as referenceLabelController from "../controllers/referenceLabelController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import multer from "multer";

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
});

const router = express.Router();

router.use(protect);

router
  .route("/")
  .get(referenceLabelController.getAllReferenceLabels)
  .post(
    upload.array("files", 10), // Accept up to 10 files
    referenceLabelController.uploadReferenceLabels
  );

router
  .route("/manual")
  .post(referenceLabelController.createReferenceLabelManual);

router
  .route("/generate-text-ai")
  .post(referenceLabelController.generateLabelAi);

router
  .route("/retry/:taskId")
  .post(referenceLabelController.retryReferenceLabelTask);

router
  .route("/:id")
  .get(referenceLabelController.getReferenceLabel)
  .delete(
    restrictToPermission("delete_eda_requirements"),
    referenceLabelController.deleteReferenceLabel
  );

export default router;
