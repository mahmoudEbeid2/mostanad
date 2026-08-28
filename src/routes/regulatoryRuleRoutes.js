import express from "express";
import { getRules, updateRule, approveRule, rejectRule, previewRules } from "../controllers/regulatoryRuleController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", restrictToPermission("read_regulatory"), getRules);
router.post("/preview", restrictToPermission("read_regulatory"), previewRules);
router.patch("/:id", restrictToPermission("approve_regulatory"), updateRule);
router.patch("/:id/approve", restrictToPermission("approve_regulatory"), approveRule);
router.patch("/:id/reject", restrictToPermission("approve_regulatory"), rejectRule);

export default router;
