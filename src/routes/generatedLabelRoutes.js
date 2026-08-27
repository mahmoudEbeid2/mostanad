import express from "express";
import { getAllLabels, getLabel, getLabelVersions, postValidate, getValidation } from "../controllers/generatedLabelController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", restrictToPermission("read_labels"), getAllLabels);
router.get("/:id", restrictToPermission("read_labels"), getLabel);
router.get("/:id/versions", restrictToPermission("read_labels"), getLabelVersions);
router.post("/:id/validate", restrictToPermission("update_labels"), postValidate);
router.get("/:id/validation", restrictToPermission("read_labels"), getValidation);

export default router;
