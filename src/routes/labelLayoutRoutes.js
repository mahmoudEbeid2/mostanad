import express from "express";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { uploadLabel } from "../middleware/uploadMiddleware.js";
import { getLayoutPdf, getLayoutPreview, postLabelUpload, getLabelUpload, postConfirmUpload, postRescaleUpload } from "../controllers/labelLayoutController.js";

// Printable label files and "Upload label to resize" (label/layout). Mounted at
// "/": protect is on each route, not router.use — a router-level protect would
// run for every request passing through this mount.
const router = express.Router();

router.get("/label-layouts/:id/pdf", protect, restrictToPermission("read_labels"), getLayoutPdf);
router.get("/label-layouts/:id/preview.png", protect, restrictToPermission("read_labels"), getLayoutPreview);

router.post("/label-uploads", protect, restrictToPermission("update_labels"), uploadLabel.single("file"), postLabelUpload);
router.get("/label-uploads/:id", protect, restrictToPermission("read_labels"), getLabelUpload);
router.post("/label-uploads/:id/confirm", protect, restrictToPermission("update_labels"), postConfirmUpload);
router.post("/label-uploads/:id/scale", protect, restrictToPermission("update_labels"), postRescaleUpload);

export default router;
