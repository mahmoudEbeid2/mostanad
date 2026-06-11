import express from "express";
import { swaggerUi, swaggerSpec } from "../../swagger.js";
import userRoutes from "./userRoutes.js";
import companyRoutes from "./companyRoutes.js";
import planRoutes from "./planRoutes.js";
import productRoutes from "./productRoutes.js";

const router = express.Router();

// Swagger UI route
router.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount routes
router.use("/users", userRoutes);
router.use("/companies", companyRoutes);
router.use("/plans", planRoutes);
router.use("/", productRoutes);

export default router;



