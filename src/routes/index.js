import express from "express";
import { swaggerUi, swaggerSpec } from "../../swagger.js";
import userRoutes from "./userRoutes.js";
import companyRoutes from "./companyRoutes.js";
import planRoutes from "./planRoutes.js";
import productRoutes from "./productRoutes.js";
import subscriptionRoutes from "./subscriptionRoutes.js";
import categoryRoutes from "./categoryRoutes.js";
import templateRoutes from "./templateRoutes.js";
import certificateRoutes from "./certificateRoutes.js";
import authRoutes from "./authRoutes.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Swagger UI route
router.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount routes
router.use("/users", protect, userRoutes);
router.use("/companies", companyRoutes); // internal protect applied in companyRoutes.js after login
router.use("/plans", protect, planRoutes);
router.use("/subscriptions", protect, subscriptionRoutes);
router.use("/categories", protect, categoryRoutes);
router.use("/", protect, productRoutes);
router.use("/", protect, templateRoutes);
router.use("/", protect, certificateRoutes);
router.use("/", authRoutes);

export default router;




