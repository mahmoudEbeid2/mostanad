import express from "express";
import {
  getAllLabels, getLabel, getLabelVersions, postValidate, getValidation, postAudit,
  postChat, getChat, patchLabel, getVersion, postRestore, getVersionsDiff, postReplay,
} from "../controllers/generatedLabelController.js";
import { postApprove, getApprovals, postRevoke } from "../controllers/labelApprovalController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", restrictToPermission("read_labels"), getAllLabels);
router.get("/:id", restrictToPermission("read_labels"), getLabel);
router.patch("/:id", restrictToPermission("update_labels"), patchLabel);
router.get("/:id/versions", restrictToPermission("read_labels"), getLabelVersions);
router.get("/:id/versions/:n", restrictToPermission("read_labels"), getVersion);
router.post("/:id/versions/:n/restore", restrictToPermission("update_labels"), postRestore);
router.get("/:id/versions/:a/diff/:b", restrictToPermission("read_labels"), getVersionsDiff);
router.post("/:id/validate", restrictToPermission("update_labels"), postValidate);
router.get("/:id/validation", restrictToPermission("read_labels"), getValidation);
router.post("/:id/audit", restrictToPermission("update_labels"), postAudit);
router.post("/:id/chat", restrictToPermission("update_labels"), postChat);
router.get("/:id/chat", restrictToPermission("read_labels"), getChat);
router.post("/:id/approve", restrictToPermission("approve_labels"), postApprove);
router.get("/:id/approvals", restrictToPermission("read_labels"), getApprovals);
router.post("/:id/approvals/:approvalId/revoke", restrictToPermission("approve_labels"), postRevoke);
router.post("/:id/replay", restrictToPermission("read_labels"), postReplay);

export default router;
