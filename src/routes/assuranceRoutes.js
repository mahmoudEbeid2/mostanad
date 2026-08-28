import express from "express";
import { getDisagreements, resolveDisagreement, getGoldenRuns, getShadowComparisons } from "../controllers/assuranceController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/disagreements", restrictToPermission("read_assurance"), getDisagreements);
router.patch("/disagreements/:id/resolve", restrictToPermission("read_assurance"), resolveDisagreement);
router.get("/golden-runs", restrictToPermission("read_assurance"), getGoldenRuns);
router.get("/shadow", restrictToPermission("read_assurance"), getShadowComparisons);

export default router;
