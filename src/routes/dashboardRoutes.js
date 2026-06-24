import express from "express";
import { getDashboardStats } from "../controllers/dashboardController.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/stats", restrictToPermission("read_dashboard"), getDashboardStats);

export default router;
