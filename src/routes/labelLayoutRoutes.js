import express from "express";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { uploadLabelDesign } from "../middleware/uploadMiddleware.js";
import { getLayoutPdf, getLayoutPreview, postLabelUpload, getLabelUpload, postConfirmUpload, postRescaleUpload, getUploadDesign, postUploadPreview, postUploadResize } from "../controllers/labelLayoutController.js";

// Printable label files and "Upload label to resize" (label/layout). Mounted at
// "/": protect is on each route, not router.use — a router-level protect would
// run for every request passing through this mount.
const router = express.Router();

router.get("/label-layouts/:id/pdf", protect, restrictToPermission("read_labels"), getLayoutPdf);
router.get("/label-layouts/:id/preview.png", protect, restrictToPermission("read_labels"), getLayoutPreview);

router.post("/label-uploads", protect, restrictToPermission("update_labels"), uploadLabelDesign.single("file"), postLabelUpload);
router.get("/label-uploads/:id", protect, restrictToPermission("read_labels"), getLabelUpload);
router.post("/label-uploads/:id/confirm", protect, restrictToPermission("update_labels"), postConfirmUpload);
router.post("/label-uploads/:id/scale", protect, restrictToPermission("update_labels"), postRescaleUpload);
// keep the design: the original's blocks (editor), a preview of sizes (nothing saved), save sizes as versions
router.get("/label-uploads/:id/design", protect, restrictToPermission("read_labels"), getUploadDesign);
router.post("/label-uploads/:id/preview", protect, restrictToPermission("update_labels"), postUploadPreview);
router.post("/label-uploads/:id/resize", protect, restrictToPermission("update_labels"), postUploadResize);

export default router;
