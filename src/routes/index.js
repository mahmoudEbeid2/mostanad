import express from "express";
import { swaggerUi, swaggerSpec } from "../../swagger.js";
import userRoutes from "./userRoutes.js";
import companyRoutes from "./companyRoutes.js";
import planRoutes from "./planRoutes.js";
import productRoutes from "./productRoutes.js";
import roleRoutes from "./roleRoutes.js";
import subscriptionRoutes from "./subscriptionRoutes.js";
import categoryRoutes from "./categoryRoutes.js";
import templateRoutes from "./templateRoutes.js";
import certificateRoutes from "./certificateRoutes.js";
import authRoutes from "./authRoutes.js";
import backgroundTaskRoutes from "./backgroundTaskRoutes.js";
import brandRoutes from "./brandRoutes.js";
import dashboardRoutes from "./dashboardRoutes.js";
import edaRequirementRoutes from "./edaRequirementRoutes.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Swagger UI route
router.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount routes
router.use("/auth", authRoutes);
router.use("/dashboard", protect, dashboardRoutes);
router.use("/users", protect, userRoutes);
router.use("/companies", companyRoutes); // internal protect applied in companyRoutes.js after login
router.use("/plans", protect, planRoutes);
router.use("/roles", protect, roleRoutes);
router.use("/subscriptions", protect, subscriptionRoutes);
router.use("/categories", protect, categoryRoutes);
router.use("/background-tasks", protect, backgroundTaskRoutes);
router.use("/brands", brandRoutes);
router.use("/eda-requirements", protect, edaRequirementRoutes);
router.use("/", protect, productRoutes);
router.use("/", protect, templateRoutes);
router.use("/", protect, certificateRoutes);

export default router;
