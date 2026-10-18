import express from "express";
import { swaggerUi, swaggerSpec } from "../../swagger.js";
import userRoutes from "./userRoutes.js";
import companyRoutes from "./companyRoutes.js";
import planRoutes from "./planRoutes.js";
import productRoutes from "./productRoutes.js";
import roleRoutes from "./roleRoutes.js";
import subscriptionRoutes from "./subscriptionRoutes.js";
import categoryRoutes from "./categoryRoutes.js";
import authRoutes from "./authRoutes.js";
import backgroundTaskRoutes from "./backgroundTaskRoutes.js";
import brandRoutes from "./brandRoutes.js";
import dashboardRoutes from "./dashboardRoutes.js";
import edaRequirementRoutes from "./edaRequirementRoutes.js";
import referenceLabelRoutes from "./referenceLabelRoutes.js";
import generatedLabelRoutes from "./generatedLabelRoutes.js";
import regulatoryDocumentRoutes from "./regulatoryDocumentRoutes.js";
import regulatoryRuleRoutes from "./regulatoryRuleRoutes.js";
import assuranceRoutes from "./assuranceRoutes.js";
import certificatesV2Routes from "./certificatesV2Routes.js";
import { getReviewInbox } from "../controllers/assuranceController.js";
import { protect, restrictToPermission } from "../middleware/authMiddleware.js";
import { health as converterHealth } from "../services/certificates/conversion/pdf2htmlexClient.js";

const router = express.Router();

// Swagger UI route
router.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Liveness + dependency reachability (CERTIFICATES_V2_PLAN.md §15). Public:
// booleans and timings only — no URLs, no tenant data.
router.get("/health", async (req, res) => {
  const t0 = Date.now();
  const c = await converterHealth();
  res.status(200).json({
    status: c.ok ? "ok" : "degraded",
    time: new Date().toISOString(),
    converter: { reachable: c.ok, ms: Date.now() - t0, ...(c.toolVersion ? { toolVersion: c.toolVersion } : {}) },
  });
});

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
router.use("/reference-labels", protect, referenceLabelRoutes);
router.use("/labels", generatedLabelRoutes); // internal protect applied in generatedLabelRoutes.js
router.use("/regulatory-documents", regulatoryDocumentRoutes); // internal protect applied in regulatoryDocumentRoutes.js
router.use("/regulatory-rules", regulatoryRuleRoutes); // internal protect applied in regulatoryRuleRoutes.js
router.use("/assurance", assuranceRoutes); // internal protect applied in assuranceRoutes.js
router.get("/review-inbox", protect, restrictToPermission("read_assurance"), getReviewInbox);
router.use("/", certificatesV2Routes); // Certificates V2 — protect + permission applied per route
router.use("/", protect, productRoutes);

export default router;
