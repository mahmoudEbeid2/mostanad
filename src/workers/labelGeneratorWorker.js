import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { GoogleGenAI } from "@google/genai";
import io from "socket.io-client";
import { MODELS } from "../services/ai/modelRegistry.js";
import * as versionService from "../services/label/versioning/versionService.js";
import { buildProductProfile } from "../services/label/retrieval/productProfile.js";
import { selectReferences } from "../services/label/retrieval/referenceSelector.js";
import { generate as generateLabel } from "../services/label/generation/labelGenerator.js";
import { validate as validateLabel } from "../services/label/validation/validationEngine.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Generator Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

async function callGeminiWithRetry(modelSpec, requestParams, retries = 5, delay = 5000) {
  const config = {
    temperature: modelSpec.temperature,
    thinkingConfig: { thinkingBudget: modelSpec.thinkingBudget },
    ...(requestParams.config || {}),
  };
  while (retries > 0) {
    try {
      return await ai.models.generateContent({ model: modelSpec.id, contents: requestParams.contents, config });
    } catch (error) {
      const msg = error.message || "";
      const isQuotaOrDemand = msg.includes("503") || msg.includes("Service Unavailable") || msg.includes("429") || msg.includes("quota");
      if (isQuotaOrDemand) {
        console.warn(`[Label Generator] Gemini API busy (503/429). Retrying in ${delay}ms... (retries left: ${retries - 1})`);
        retries--;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.floor(delay * 1.5);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Gemini API failed after all retries due to high demand.");
}

// Per-field provenance (Invariant #3 / §14.4), rebuilt for Phase 4's real
// labelSchema fields and real tier information — supersedes Phase 1's stopgap
// (which never had Tier 1 because productProfile.js didn't exist yet).
function buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData }) {
  const at = new Date().toISOString();
  const modelId = generationMeta.modelId;
  const refused = new Set(generationMeta.refusedUngroundedFields || []);
  const estimated = new Set(labelData.estimatedFields || []);
  const bestRefIds = rankedReferences.filter((r) => r.tier === "exact_combo" || r.tier === "ingredient").map((r) => r.reference.id);
  const provenance = {};
  const set = (path, tier, source, sourceRef = null) => {
    provenance[path] = { tier, provenance: source, sourceRef, modelId, at };
  };

  set("targetAnimalSpecies.list",
    targetAnimalsSource === "confirmed" ? (profile.provenance.fromProductRow.includes("targetSpecies") ? 1 : 2) : targetAnimalsSource === "reference" ? 4 : 6,
    targetAnimalsSource,
    targetAnimalsSource === "reference" ? { kind: "reference_label", ids: bestRefIds } : null);

  // The absolute-exclusion fields: tier is 1 (Product row) if grounded and not
  // refused, else 6/refused (the grounding policy already nulled the value).
  for (const path of ["withdrawalPeriod", "strength", "registrationNumber"]) {
    if (refused.has(path)) set(path, 6, "refused_ungrounded");
    else if (profile[path]) set(path, 1, "confirmed", { kind: "product_row", field: path });
    else if (labelData[path] && bestRefIds.length > 0) set(path, 4, "reference", { kind: "reference_label", ids: bestRefIds });
  }
  for (const path of ["batchNo", "expiryDate"]) {
    if (refused.has(path)) set(path, 6, "refused_ungrounded");
  }

  for (const path of ["aimOfUse", "directionOfUse", "storage"]) {
    if (profile.confirmedFacts[path]) set(path, 2, "confirmed", { kind: "user_hint", field: `${path}Hint` });
    else if (bestRefIds.length > 0) set(path, 4, "reference", { kind: "reference_label", ids: bestRefIds });
    else set(path, estimated.has(path) ? 5 : 6, "inferred");
  }

  for (const path of ["productName", "feedClassification", "activeIngredients", "netWeight", "usageDeclaration"]) {
    set(path, estimated.has(path) ? 5 : 3, estimated.has(path) ? "inferred" : "extracted");
  }

  return provenance;
}

const connection = getRedisConfig();

export const labelGeneratorWorker = new Worker(
  "labelGeneratorQueue",
  async (job) => {
    const { taskId, companyId, createdByUserId, productId, formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint } = job.data;

    console.log(`[Label Generator] Started task: ${taskId} for Country: ${country}, Language: ${language}`);

    try {
      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 10, message: "Building product profile..." });

      // Step 1: Product profile (§8.1) — reads the Product row when productId is
      // given (fixes G2: generation used to never read it at all).
      const profile = await buildProductProfile({
        productId,
        formulationText,
        country,
        language,
        hints: { aimOfUseHint, targetSpeciesHint, directionOfUseHint },
      });
      profile.companyId = companyId;

      // Step 1b: extract ingredient names from free text ONLY to widen reference
      // matching when the Product row didn't already supply them — never used to
      // fill an amount or any other confirmed field.
      if (profile.activeIngredients.length === 0 && formulationText) {
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 20, message: "Extracting active ingredients..." });
        try {
          const extractResult = await callGeminiWithRetry(MODELS.EXTRACT, { contents: `Extract the primary active ingredient names from this formulation text as a comma-separated list, nothing else:\n${formulationText}` });
          const names = extractResult.text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
          profile.activeIngredients = names.map((n) => ({ normalizedName: n, amount: null, unit: null, strengthMgPerUnit: null }));
        } catch (err) {
          console.error(`[Label Generator] Task ${taskId}: Ingredient extraction failed, continuing without it.`, err);
        }
      }

      // Step 2: Reference selection (§8.3/§8.4) — tenant-scoped, weighted, tier
      // computed in code. Weighted ranking is unproven at this environment's
      // current reference volume (0 rows) but the query/scoring/tiering itself
      // is real, not a stub — see similarity.js.
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 35, message: "Searching for matching reference labels..." });
      const rankedReferences = await selectReferences(profile, { take: 200, topK: 3 });

      // Step 3: Regulatory rules for this country (Phase 3's real output) plus
      // best-available advisory text (approved > pending_review) for drafting
      // quality even before rules exist for a country.
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 45, message: "Loading regulatory requirements..." });
      const approvedDocuments = await prisma.regulatoryDocument.findMany({ where: { country: { equals: country, mode: "insensitive" }, status: "approved" }, select: { id: true } });
      const rules = approvedDocuments.length > 0
        ? await prisma.regulatoryRule.findMany({ where: { documentId: { in: approvedDocuments.map((d) => d.id) }, status: "approved" } })
        : [];

      // Step 4: Constrained generation (§9, schema-forced via responseJsonSchema —
      // G6 fixed. No more free-form JSON coerced after the fact).
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 70, message: "Generating label..." });
      const { labelData, generationMeta, matchTier, referenceLabelIds, targetAnimalsSource } = await generateLabel({ profile, rankedReferences, rules });

      console.log(`[Label Generator] Task ${taskId}: cachedTokens=${generationMeta.cachedTokens}, refusedFields=${JSON.stringify(generationMeta.refusedUngroundedFields)}`);

      // Step 5: Persist — GeneratedLabel + LabelVersion v1 + per-field provenance.
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 90, message: "Saving and validating..." });
      const labelProvenance = buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData });

      const label = await versionService.createInitial({
        companyId,
        createdByUserId,
        productId,
        inputPayload: { formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint },
        productProfile: profile,
        labelData,
        labelProvenance,
        schemaVersion: generationMeta.schemaVersion,
        country,
        language,
        referenceLabelIds,
        matchTier,
        generationMeta,
      });

      // Step 6: engine unification closes the loop — a schema-conformant label
      // gets an initial ValidationReport immediately, same validationEngine
      // labelExtractor's uploaded labels go through (§4.2).
      const report = validateLabel(labelData, { rules });
      await prisma.validationReport.create({
        data: {
          labelId: label.id,
          versionNumber: 1,
          passed: report.passed,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          verdicts: report.verdicts,
          coveragePercent: report.coveragePercent,
          engineVersion: report.engineVersion,
          rulesetIds: report.rulesetIds,
          aiAssisted: report.aiAssisted,
        },
      });
      await prisma.generatedLabel.update({ where: { id: label.id }, data: { status: report.passed ? "validated" : "failed_validation" } });

      const result = { taskId, labelId: label.id, label: labelData, validation: { passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount } };

      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", result } });
      socket.emit("job_status_update", { jobId: taskId, status: "completed", progress: 100, result, message: "Label generated successfully!" });
      console.log(`[Label Generator] Task ${taskId} completed successfully. Label ID: ${label.id}, validation passed: ${report.passed}`);
    } catch (error) {
      console.error(`[Label Generator] Job failed:`, error);
      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "failed", error: error.message || "Unknown error occurred" } });
      socket.emit("job_status_update", { jobId: taskId, status: "failed", progress: 0, error: error.message, message: error.message });
      throw error;
    }
  },
  { connection, concurrency: 2 }
);

labelGeneratorWorker.on("completed", (job) => {
  console.log(`Job ${job.id} has completed!`);
});

labelGeneratorWorker.on("failed", (job, err) => {
  console.log(`Job ${job.id} has failed with ${err.message}`);
});

console.log("[Label Generator Worker] Started listening to labelGeneratorQueue...");
