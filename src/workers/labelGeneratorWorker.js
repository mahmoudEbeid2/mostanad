import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import io from "socket.io-client";
import geminiClient from "../services/ai/geminiClient.js";
import { MODELS } from "../services/ai/modelRegistry.js";
import { withGenerationMetrics, generationMetricsSnapshot } from "../services/ai/generationMetrics.js";
import * as versionService from "../services/label/versioning/versionService.js";
import { buildProductProfile } from "../services/label/retrieval/productProfile.js";
import { selectReferences } from "../services/label/retrieval/referenceSelector.js";
import { generate as generateLabel } from "../services/label/generation/labelGenerator.js";
import { validate as validateLabel } from "../services/label/validation/validationEngine.js";
import { riskScore, autonomyTierFor } from "../services/label/assurance/riskScorer.js";
import { refusalReasonFor, GROUNDED_CONTENT_FIELDS } from "../services/label/generation/groundingPolicy.js";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Generator Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

// Per-field provenance (Invariant #3 / §14.4), rebuilt for Phase 4's real
// labelSchema fields and real tier information — supersedes Phase 1's stopgap
// (which never had Tier 1 because productProfile.js didn't exist yet).
function buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData, groundedFacts = {}, unresolvedContentFields = [] }) {
  const at = new Date().toISOString();
  const modelId = generationMeta.modelId;
  const promptHash = generationMeta.promptHash;
  const refused = new Set(generationMeta.refusedUngroundedFields || []);
  const estimated = new Set(labelData.estimatedFields || []);
  const bestRefIds = rankedReferences.filter((r) => r.tier === "exact_combo" || r.tier === "ingredient").map((r) => r.reference.id);
  const provenance = {};
  const set = (path, tier, source, sourceRef = null, extra = {}) => {
    provenance[path] = { tier, provenance: source, sourceRef, modelId, promptHash, at, ...extra };
  };

  set("targetAnimalSpecies.list",
    targetAnimalsSource === "confirmed" ? (profile.provenance.fromProductRow.includes("targetSpecies") ? 1 : 2) : targetAnimalsSource === "reference" ? 4 : targetAnimalsSource === "external" ? 5 : 6,
    targetAnimalsSource,
    targetAnimalsSource === "reference" ? { kind: "reference_label", ids: bestRefIds } : null,
    targetAnimalsSource === "inferred" ? { refusalReason: null } : {});

  // The absolute-exclusion fields (Invariant #5, §8.2's exclusions): tier is 1
  // (Product row) if grounded, 6/refused with a refusalReason if the grounding
  // policy nulled the value — never left ambiguous as to why it's empty.
  for (const path of ["withdrawalPeriod", "strength", "registrationNumber", "shelfLifeAfterOpening"]) {
    if (refused.has(path)) set(path, 6, "refused_ungrounded", null, { refusalReason: refusalReasonFor(path) });
    else if (profile[path]) set(path, 1, "confirmed", { kind: "product_row", field: path });
    else if (labelData[path] && bestRefIds.length > 0) set(path, 4, "reference", { kind: "reference_label", ids: bestRefIds });
    else if (!labelData[path]) set(path, 6, "refused_ungrounded", null, { refusalReason: refusalReasonFor(path) });
  }
  for (const path of ["batchNo", "expiryDate"]) {
    if (refused.has(path)) set(path, 6, "refused_ungrounded", null, { refusalReason: refusalReasonFor(path) });
  }

  // §8.2's ladder for content fields — groundedFacts already carries the real
  // tier/citation/sourceUrl computed in fieldLadder.js (code-computed, never
  // the model's self-report of where it got something). Fields the ladder
  // could not resolve are UNVERIFIABLE with a reason, not silently blank.
  for (const path of GROUNDED_CONTENT_FIELDS) {
    if (path === "targetAnimalSpecies") continue;
    const fact = groundedFacts[path];
    if (fact) {
      set(path, fact.tier, fact.provenance, fact.sourceRef, { citation: fact.citation, sourceUrl: fact.sourceUrl });
    } else if (unresolvedContentFields.includes(path)) {
      set(path, 6, "unverifiable", null, { status: "UNVERIFIABLE", refusalReason: `Not estimated — no confirmed source, matched reference, or citable authoritative source found for "${path}".` });
    } else {
      // directionOfUse/storage when unresolved: schema requires content, so
      // generation wrote a generic best-effort draft (mustStillWrite in
      // labelGenerator.js) — flagged as estimated, not silently trusted.
      set(path, estimated.has(path) ? 5 : 4, estimated.has(path) ? "inferred" : "reference", bestRefIds.length > 0 ? { kind: "reference_label", ids: bestRefIds } : null);
    }
  }

  for (const path of ["aimOfUse"]) {
    if (profile.confirmedFacts[path]) set(path, 2, "confirmed", { kind: "user_hint", field: `${path}Hint` });
    else if (bestRefIds.length > 0) set(path, 4, "reference", { kind: "reference_label", ids: bestRefIds });
    else set(path, estimated.has(path) ? 5 : 6, "inferred");
  }

  for (const path of ["productName", "activeIngredients", "netWeight", "usageDeclaration"]) {
    set(path, estimated.has(path) ? 5 : 3, estimated.has(path) ? "inferred" : "extracted");
  }

  return provenance;
}

const connection = getRedisConfig();

export const labelGeneratorWorker = new Worker(
  "labelGeneratorQueue",
  // CLAUDE.md item 5: withGenerationMetrics gives every geminiClient call made
  // anywhere during this job (extraction, generation, and anything future
  // steps add) a shared bucket to record into — see generationMetrics.js.
  (job) => withGenerationMetrics(async () => {
    const { taskId, companyId, createdByUserId, productId, formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint } = job.data;

    console.log(`[Label Generator] Started task: ${taskId} for Country: ${country}, Language: ${language}`);

    try {
      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 10, message: "Building product profile..." });

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

      let referenceGroundingFailed = false;

      // Step 1b: extract ingredient names from free text ONLY to widen reference
      // matching when the Product row didn't already supply them — never used to
      // fill an amount or any other confirmed field.
      // Invariant #7: if extraction fails, record referenceGroundingFailed = true
      // and matchTier = "none", emitting UNVERIFIABLE on reference-grounded fields.
      if (profile.activeIngredients.length === 0 && formulationText) {
        socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 20, message: "Extracting active ingredients..." });
        try {
          const extractText = await geminiClient.generateText({
            model: MODELS.EXTRACT.id,
            contents: `Extract the primary active ingredient names from this formulation text as a comma-separated list, nothing else:\n${formulationText}`,
            config: { temperature: MODELS.EXTRACT.temperature, thinkingConfig: { thinkingBudget: MODELS.EXTRACT.thinkingBudget } },
          });
          const names = extractText.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
          profile.activeIngredients = names.map((n) => ({ normalizedName: n, amount: null, unit: null, strengthMgPerUnit: null }));
        } catch (err) {
          console.error(`[Label Generator] Task ${taskId}: Ingredient extraction failed (Invariant #7): ${err.message}`);
          referenceGroundingFailed = true;
        }
      }

      // Step 2: Reference selection (§8.3/§8.4) — tenant-scoped, weighted, tier
      // computed in code. Weighted ranking is unproven at this environment's
      // current reference volume (0 rows) but the query/scoring/tiering itself
      // is real, not a stub — see similarity.js.
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 35, message: "Searching for matching reference labels..." });
      const rankedReferences = referenceGroundingFailed ? [] : await selectReferences(profile, { take: 200, topK: 3 });

      // Step 3: Regulatory rules for this country (Phase 3's real output) plus
      // best-available advisory text (approved > pending_review) for drafting
      // quality even before rules exist for a country.
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 45, message: "Loading regulatory requirements..." });
      const approvedDocuments = await prisma.regulatoryDocument.findMany({ where: { country: { equals: country, mode: "insensitive" }, status: "approved" }, select: { id: true } });
      const rules = approvedDocuments.length > 0
        ? await prisma.regulatoryRule.findMany({ where: { documentId: { in: approvedDocuments.map((d) => d.id) }, status: "approved" } })
        : [];

      // Step 4: Constrained generation (§9, schema-forced via responseJsonSchema —
      // G6 fixed. No more free-form JSON coerced after the fact).
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 70, message: "Generating label..." });
      const { labelData, generationMeta, matchTier: generatedTier, referenceLabelIds, targetAnimalsSource, groundedFacts, unresolvedContentFields } = await generateLabel({ profile, rankedReferences, rules });
      const matchTier = referenceGroundingFailed ? "none" : generatedTier;

      console.log(`[Label Generator] Task ${taskId}: cachedTokens=${generationMeta.cachedTokens}, refusedFields=${JSON.stringify(generationMeta.refusedUngroundedFields)}`);

      // CLAUDE.md item 5: real per-label cost, not an estimate — every
      // geminiClient call made since withGenerationMetrics() opened this job
      // (ingredient extraction + generation, so far; audit/self-consistency
      // will fold in automatically once/if they're wired into this same job).
      generationMeta.geminiUsage = generationMetricsSnapshot();
      console.log(`[Label Generator] Task ${taskId}: geminiUsage=${JSON.stringify(generationMeta.geminiUsage)}`);

      // Step 5: Persist — GeneratedLabel + LabelVersion v1 + per-field provenance.
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 90, message: "Saving and validating..." });
      const labelProvenance = buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData, groundedFacts, unresolvedContentFields });

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
      const report = await validateLabel(labelData, { rules, referenceGroundingFailed, includePlausibility: false });
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
      // Step 7 (§14.6): risk score + autonomy tier, computed in code from the
      // label content and this version's validation report. disagreementCount
      // starts at 0 here — the adversarial auditor (Phase 5) runs separately
      // via POST /labels/:id/audit, not on every generation (a second model
      // call on every job would double generation cost for every label).
      const document = approvedDocuments.length > 0 ? await prisma.regulatoryDocument.findFirst({ where: { id: { in: approvedDocuments.map((d) => d.id) } } }) : null;
      const score = riskScore(labelData, report, { document, disagreementCount: 0, labelProvenance });
      const { tier: autonomyTier } = autonomyTierFor(score);
      await prisma.generatedLabel.update({ where: { id: label.id }, data: { status: report.passed ? "validated" : "failed_validation", riskScore: score, autonomyTier } });

      const result = { taskId, labelId: label.id, label: labelData, labelProvenance, validation: { passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount, verdicts: report.verdicts }, riskScore: score, autonomyTier };

      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", result } });
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "completed", progress: 100, result, message: "Label generated successfully!" });
      console.log(`[Label Generator] Task ${taskId} completed successfully. Label ID: ${label.id}, validation passed: ${report.passed}`);
    } catch (error) {
      // CLAUDE.md item 3: geminiClient now throws Google's real status/message
      // (not a generic "API busy" string), so error.message landing on
      // BackgroundTask.error is enough for the UI to show the real failure —
      // including "quota exhausted" vs "rate limited" vs anything else.
      console.error(`[Label Generator] Job failed:`, error);
      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "failed", error: error.message || "Unknown error occurred" } });
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "failed", progress: 0, error: error.message, message: error.message });
      throw error;
    }
  }),
  { connection, concurrency: 2 }
);

labelGeneratorWorker.on("completed", (job) => {
  console.log(`Job ${job.id} has completed!`);
});

labelGeneratorWorker.on("failed", (job, err) => {
  console.log(`Job ${job.id} has failed with ${err.message}`);
});

console.log("[Label Generator Worker] Started listening to labelGeneratorQueue...");
