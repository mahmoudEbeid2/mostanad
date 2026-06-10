import express from "express";
import { swaggerUi, swaggerSpec } from "../../swagger.js";
import userRoutes from "./userRoutes.js";

const router = express.Router();

// Swagger UI route
router.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount user routes
router.use("/users", userRoutes);

export default router;
