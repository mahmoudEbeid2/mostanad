import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import io from "socket.io-client";
import { geminiWorkerName } from "../services/ai/geminiGuard.js";
import geminiClient from "../services/ai/geminiClient.js";
import { MODELS } from "../services/ai/modelRegistry.js";
import { withGenerationMetrics, generationMetricsSnapshot } from "../services/ai/generationMetrics.js";
import * as versionService from "../services/label/versioning/versionService.js";
import { buildProductProfile } from "../services/label/retrieval/productProfile.js";
import { selectReferences } from "../services/label/retrieval/referenceSelector.js";
import { generate as generateLabel } from "../services/label/generation/labelGenerator.js";
import { getApprovedRulesForCountry } from "../services/label/regulatory/regulatoryDocumentService.js";
import { recordOutcomes } from "../services/label/regulatory/ruleOutcomeTracker.js";
import { buildLabelSchema, getKnownDiscriminants } from "../services/label/schema/composer.js";
import { deriveDiscriminants } from "../services/label/schema/deriveDiscriminants.js";
import { validate as validateLabel } from "../services/label/validation/validationEngine.js";
import { riskScore, autonomyTierFor } from "../services/label/assurance/riskScorer.js";
import { estimateBasisFor, GROUNDED_CONTENT_FIELDS, NEVER_GUESS_FIELDS } from "../services/label/generation/groundingPolicy.js";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Generator Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

// Per-field provenance (Invariant #3 / §14.4), rebuilt for Phase 4's real
// labelSchema fields and real tier information — supersedes Phase 1's stopgap
// (which never had Tier 1 because productProfile.js didn't exist yet).
function buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData, groundedFacts = {}, groundedNeverGuessPaths = {}, unresolvedContentFields = [] }) {
  const at = new Date().toISOString();
  const modelId = generationMeta.modelId;
  const promptHash = generationMeta.promptHash;
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

  // NEVER_GUESS_FIELDS (amended Invariant #5 — "every field is generated,
  // none render blank"): classifyNeverGuessFields (labelGenerator.js) already
  // decided, for every one of these, whether it's grounded (tier 1/4/5, real
  // source — groundedNeverGuessPaths) or a Tier 6 estimate (labelData.estimatedFields).
  // Every field lands in exactly one bucket — never left ambiguous as to why
  // a value is (or isn't) trustworthy as printed.
  for (const path of NEVER_GUESS_FIELDS) {
    if (path === "activeIngredients[].amount") continue; // per-ingredient, handled below
    const fact = groundedNeverGuessPaths[path];
    if (fact) set(path, fact.tier, fact.provenance, fact.sourceRef, { citation: fact.citation || null, sourceUrl: fact.sourceUrl || null });
    else if (estimated.has(path)) set(path, 6, "inferred", null, { estimated: true, estimateBasis: estimateBasisFor(path) });
  }
  (labelData.activeIngredients || []).forEach((_, i) => {
    const path = `activeIngredients[${i}].amount`;
    const fact = groundedNeverGuessPaths[path];
    if (fact) set(path, fact.tier, fact.provenance, fact.sourceRef);
    else if (estimated.has(path)) set(path, 6, "inferred", null, { estimated: true, estimateBasis: estimateBasisFor("activeIngredients[].amount") });
  });

  // §8.2's ladder for content fields — groundedFacts already carries the real
  // tier/citation/sourceUrl computed in fieldLadder.js (code-computed, never
  // the model's self-report of where it got something). A field the ladder
  // couldn't resolve AND the model left empty is UNVERIFIABLE with a reason;
  // one the model filled anyway is Tier 6 "inferred" — real content, not
  // grounded in a citation, always in estimatedFields for human review.
  for (const path of GROUNDED_CONTENT_FIELDS) {
    if (path === "targetAnimalSpecies") continue;
    const fact = groundedFacts[path];
    if (fact) {
      set(path, fact.tier, fact.provenance, fact.sourceRef, { citation: fact.citation, sourceUrl: fact.sourceUrl });
    } else if (unresolvedContentFields.includes(path)) {
      set(path, 6, "unverifiable", null, { status: "UNVERIFIABLE", refusalReason: `Not estimated — no confirmed source, matched reference, citable authoritative source, or reliable inference was available for "${path}".` });
    } else {
      set(path, 6, "inferred", null, { refusalReason: null });
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

      // Step 3: Regulatory rules for this country (Phase 3's real output).
      // getApprovedRulesForCountry (not an inline query) so this picks up the
      // SAME tenant scoping (Invariant #10's spirit) the actual validation
      // path already uses — the old inline query here had no companyId filter
      // at all, which meant a private document's rules could leak into a
      // different company's generation PROMPT, not just its validation.
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 45, message: "Loading regulatory requirements..." });
      const rules = await getApprovedRulesForCountry(country, { companyId });

      // Step 3b: compose the label schema (§3) — tenant-scoped catalog fields
      // from ingested regulatory documents, merged with the static core
      // schema. Discriminants are auto-derived from the product profile where
      // the wording resembles it (deriveDiscriminants.js); anything that
      // can't be matched this way is reported, not guessed — a frontend
      // change to collect it directly from the user is a separate task.
      const knownDiscriminants = await getKnownDiscriminants({ countryCode: country, companyId });
      const { resolved: discriminants, unresolved: unresolvedDiscriminants } = deriveDiscriminants(profile, knownDiscriminants);
      if (unresolvedDiscriminants.length > 0) {
        console.log(`[Label Generator] Task ${taskId}: ${unresolvedDiscriminants.length} discriminant(s) could not be derived from product data — composing without them: ${JSON.stringify(unresolvedDiscriminants.map((d) => d.key))}`);
      }
      const { fields: composedFields, unrecognizedDiscriminantKeys } = await buildLabelSchema({ countryCode: country, companyId, discriminants });
      if (unrecognizedDiscriminantKeys.length > 0) {
        console.warn(`[Label Generator] Task ${taskId}: unrecognized discriminant key(s) reported by composer: ${JSON.stringify(unrecognizedDiscriminantKeys)}`);
      }

      // Step 4: Constrained generation (§9, schema-forced via responseJsonSchema —
      // G6 fixed. No more free-form JSON coerced after the fact).
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 70, message: "Generating label..." });
      const { labelData, generationMeta, matchTier: generatedTier, referenceLabelIds, targetAnimalsSource, groundedFacts, groundedNeverGuessPaths, unresolvedContentFields } = await generateLabel({ profile, rankedReferences, rules, composedFields, discriminants });
      const matchTier = referenceGroundingFailed ? "none" : generatedTier;

      if (generationMeta.rejectedSchemaKeys?.length > 0) {
        console.warn(`[Label Generator] Task ${taskId}: model produced key(s) outside the composed schema — rejected: ${JSON.stringify(generationMeta.rejectedSchemaKeys)}`);
      }
      console.log(`[Label Generator] Task ${taskId}: composedFields=${composedFields.length}, cachedTokens=${generationMeta.cachedTokens}, estimatedNeverGuessFields=${JSON.stringify(generationMeta.estimatedNeverGuessFields)}`);

      // CLAUDE.md item 5: real per-label cost, not an estimate — every
      // geminiClient call made since withGenerationMetrics() opened this job
      // (ingredient extraction + generation, so far; audit/self-consistency
      // will fold in automatically once/if they're wired into this same job).
      generationMeta.geminiUsage = generationMetricsSnapshot();
      console.log(`[Label Generator] Task ${taskId}: geminiUsage=${JSON.stringify(generationMeta.geminiUsage)}`);

      // Step 5: Persist — GeneratedLabel + LabelVersion v1 + per-field provenance.
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 90, message: "Saving and validating..." });
      const labelProvenance = buildFieldProvenance({ profile, rankedReferences, targetAnimalsSource, generationMeta, labelData, groundedFacts, groundedNeverGuessPaths, unresolvedContentFields });

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
      // labelExtractor's uploaded labels go through (§4.2). §5: composedFields
      // passed through so validation follows the SAME composed list generation
      // was constrained to, not a re-derivation.
      const report = await validateLabel(labelData, { rules, referenceGroundingFailed, includePlausibility: false, composedFields });
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
      await recordOutcomes(rules, report.verdicts, { labelId: label.id, discriminants });

      // Step 7 (§14.6): risk score + autonomy tier, computed in code from the
      // label content and this version's validation report. disagreementCount
      // starts at 0 here — the adversarial auditor (Phase 5) runs separately
      // via POST /labels/:id/audit, not on every generation (a second model
      // call on every job would double generation cost for every label).
      // Tenant-scoped the same way getApprovedRulesForCountry is now.
      const document = await prisma.regulatoryDocument.findFirst({ where: { country: { equals: country, mode: "insensitive" }, status: "approved", OR: [{ companyId }, { companyId: null }] } });
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
  { connection, concurrency: 2, name: geminiWorkerName("labelGeneratorQueue") }
);

labelGeneratorWorker.on("completed", (job) => {
  console.log(`Job ${job.id} has completed!`);
});

labelGeneratorWorker.on("failed", (job, err) => {
  console.log(`Job ${job.id} has failed with ${err.message}`);
});

console.log("[Label Generator Worker] Started listening to labelGeneratorQueue...");
