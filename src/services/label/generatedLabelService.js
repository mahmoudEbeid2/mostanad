import { assignAiContext } from "../ai/aiContext.js";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { validate } from "./validation/validationEngine.js";
import { audit, compareVerdicts } from "./validation/adversarialAuditor.js";
import { riskScore, autonomyTierFor } from "./assurance/riskScorer.js";
import { classifyIntent, answerQuestion, proposePatch } from "./editing/chatAgent.js";
import { dryRunPatch } from "./editing/patchApplier.js";
import * as versionService from "./versioning/versionService.js";
import { getApprovedRulesForCountry } from "./regulatory/regulatoryDocumentService.js";
import { recordOutcomes } from "./regulatory/ruleOutcomeTracker.js";

/**
 * companyId: forced by the controller for a company caller; optional filter
 * for a system user. Never unscoped for a company caller (Invariant #10).
 */
export const getAll = async ({ page = 1, limit = 20, companyId, productId } = {}) => {
  const where = {};
  if (companyId) where.companyId = companyId;
  if (productId) where.productId = productId;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const [labels, total] = await Promise.all([
    prisma.generatedLabel.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        companyId: true,
        productId: true,
        country: true,
        language: true,
        status: true,
        matchTier: true,
        currentVersion: true,
        riskScore: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.generatedLabel.count({ where }),
  ]);

  return { labels, total };
};

/**
 * companyId: when provided, the label must belong to it or this throws 404 —
 * never 403, so an out-of-tenant id doesn't confirm the record exists.
 */
export const getById = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({
    where: { id },
    include: {
      validations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }

  return {
    label,
    currentVersion: label.currentVersion,
    latestValidation: label.validations[0] || null,
    provenance: label.labelProvenance,
  };
};

export const getVersions = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }

  return prisma.labelVersion.findMany({
    where: { labelId: id },
    orderBy: { versionNumber: "asc" },
  });
};

/**
 * Re-runs the deterministic engine (layers 1-4) against the label's CURRENT
 * labelData and persists a new ValidationReport. rules: [] until Phase 3
 * populates real RegulatoryRule[] for (country, productScope).
 */
export const runValidation = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  assignAiContext({ companyId: label.companyId, entityType: "label", entityId: id }); // AI cost ledger

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  const report = await validate(label.labelData, { rules, extractionMeta: label.extractionMeta });

  const saved = await prisma.validationReport.create({
    data: {
      labelId: id,
      versionNumber: label.currentVersion,
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

  await prisma.generatedLabel.update({
    where: { id },
    data: { status: report.passed ? "validated" : "failed_validation" },
  });

  await recordOutcomes(rules, report.verdicts, { labelId: id, discriminants: label.generationMeta?.discriminants });

  return saved;
};

export const getLatestValidation = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }

  const latest = await prisma.validationReport.findFirst({
    where: { labelId: id },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) {
    throw new AppError("This label has not been validated yet — POST /labels/:id/validate first.", 404);
  }
  return latest;
};

/**
 * §14.1's adversarial audit. Runs an independent model (see modelRegistry's
 * AUDITOR comment on the same-family compromise) against ONLY labelData +
 * rules + confirmed facts, compares to the deterministic verdicts, persists
 * every disagreement (never auto-resolved — a human decides resolution),
 * and recomputes risk/autonomy since disagreementCount feeds §14.6's formula.
 */
// CLAUDE.md item 4: defaults to true in production; set false to cut the
// adversarial audit's 1 call out of a label's Gemini call count while testing
// against a constrained key.
export const ADVERSARIAL_AUDIT_ENABLED = process.env.ENABLE_ADVERSARIAL_AUDIT !== "false";

export const runAudit = async (id, { companyId } = {}) => {
  if (!ADVERSARIAL_AUDIT_ENABLED) {
    throw new AppError("Adversarial audit is disabled (ENABLE_ADVERSARIAL_AUDIT=false).", 503);
  }

  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  assignAiContext({ companyId: label.companyId, entityType: "label", entityId: id }); // AI cost ledger

  const latestReport = await prisma.validationReport.findFirst({ where: { labelId: id }, orderBy: { createdAt: "desc" } });
  if (!latestReport) throw new AppError("This label has not been validated yet — POST /labels/:id/validate first.", 400);

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  let auditorVerdicts;
  try {
    auditorVerdicts = await audit(label.labelData, { rules, confirmedFacts: label.inputPayload });
  } catch (err) {
    throw new AppError(`AI service temporarily unavailable — could not run the audit: ${err.message}`, 503);
  }
  const disagreements = compareVerdicts(latestReport.verdicts, auditorVerdicts);

  for (const d of disagreements) {
    await prisma.auditDisagreement.create({
      data: {
        labelId: id,
        versionNumber: label.currentVersion,
        fieldPath: d.fieldPath,
        deterministicVerdict: d.deterministicVerdict,
        auditorVerdict: d.auditorVerdict,
        auditorReasoning: d.auditorReasoning,
      },
    });
  }

  await prisma.validationReport.update({
    where: { id: latestReport.id },
    data: { auditorVerdicts, disagreementCount: disagreements.length, aiAssisted: true },
  });

  const document = await prisma.regulatoryDocument.findFirst({ where: { country: label.country, status: "approved" } });
  const score = riskScore(label.labelData, latestReport, { document, disagreementCount: disagreements.length, labelProvenance: label.labelProvenance });
  const { tier: autonomyTier } = autonomyTierFor(score);
  await prisma.generatedLabel.update({ where: { id }, data: { riskScore: score, autonomyTier } });

  return { auditorVerdicts, disagreements, riskScore: score, autonomyTier };
};

export const getDisagreements = async ({ labelId, resolution, page = 1, limit = 50 } = {}) => {
  const where = {};
  if (labelId) where.labelId = labelId;
  if (resolution) where.resolution = resolution;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);
  const [disagreements, total] = await Promise.all([
    prisma.auditDisagreement.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.auditDisagreement.count({ where }),
  ]);
  return { disagreements, total };
};

export const resolveDisagreement = async (id, { resolution, becameRuleId }) => {
  const disagreement = await prisma.auditDisagreement.findUnique({ where: { id } });
  if (!disagreement) throw new AppError("No audit disagreement found with that ID", 404);
  return prisma.auditDisagreement.update({ where: { id }, data: { resolution, becameRuleId: becameRuleId || null } });
};

/**
 * §14.6's "one box" — every label needing human attention, sorted by risk
 * descending, regardless of why it needs attention. A design that scatters
 * review across separate queues per reason is a design nobody checks fully.
 */
export const getReviewInbox = async ({ companyId, page = 1, limit = 20 } = {}) => {
  const where = {
    status: { in: ["validated", "failed_validation"] },
    ...(companyId && { companyId }),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);
  const [labels, total] = await Promise.all([
    prisma.generatedLabel.findMany({
      where,
      orderBy: { riskScore: "desc" },
      skip,
      take,
      select: { id: true, companyId: true, productId: true, country: true, status: true, riskScore: true, autonomyTier: true, currentVersion: true, createdAt: true },
    }),
    prisma.generatedLabel.count({ where }),
  ]);
  return { labels, total };
};

async function loadLabelForChat(id, companyId) {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  assignAiContext({ companyId: label.companyId, entityType: "label", entityId: id }); // AI cost ledger
  const report = await prisma.validationReport.findFirst({ where: { labelId: id }, orderBy: { createdAt: "desc" } });
  return { label, report };
}

/**
 * §11.5's full cycle. Guards #6/#7 (§11.4): optimistic lock on expectedVersion,
 * status lock on "generating" (currently unreachable — GeneratedLabel rows are
 * only created post-generation today — kept for when a future phase persists
 * a row before generation completes).
 */
export const chat = async (id, { message, expectedVersion, overrideAcknowledged = false, userId, companyId } = {}) => {
  const { label, report } = await loadLabelForChat(id, companyId);

  if (label.status === "generating") {
    throw new AppError("This label is still being generated — try again shortly.", 423);
  }
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== label.currentVersion) {
    throw new AppError(`Version conflict: expected ${expectedVersion}, label is now at ${label.currentVersion}. Reload before editing.`, 409);
  }

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  let intent;
  try {
    intent = await classifyIntent(message);
  } catch (err) {
    throw new AppError(`AI service temporarily unavailable — could not process this message: ${err.message}`, 503);
  }

  const saveMessage = (extra) => prisma.labelChatMessage.create({ data: { labelId: id, role: "user", content: message, intent, userId, ...extra } });

  if (intent === "question" || intent === "explain_validation") {
    let answer;
    try {
      answer = await answerQuestion(message, { labelData: label.labelData, report, rules });
    } catch (err) {
      throw new AppError(`AI service temporarily unavailable — could not answer: ${err.message}`, 503);
    }
    await saveMessage({});
    await prisma.labelChatMessage.create({ data: { labelId: id, role: "assistant", content: answer, intent } });
    return { intent, answer };
  }

  // intent === "edit"
  let patch;
  try {
    patch = await proposePatch(message, { labelData: label.labelData, report });
  } catch (err) {
    throw new AppError(`AI service temporarily unavailable — could not propose an edit: ${err.message}`, 503);
  }
  const dryRun = await dryRunPatch(label.labelData, report, patch, { rules });

  // A refused patch is an OUTCOME of the operation, not a transport failure —
  // it carries path/reason/previousValue so the UI can render exactly what
  // was rejected and why, the same way "conflict" already does. Never thrown:
  // an exception here would give the client no path/reason to render, only
  // "something went wrong".
  if (dryRun.status === "invalid") {
    await saveMessage({ proposedPatch: patch, conflicts: { errors: dryRun.errors } });
    const primary = dryRun.errors[0] || { path: null, reason: "Patch rejected.", previousValue: undefined };
    return { intent, status: "refused", path: primary.path, reason: primary.reason, previousValue: primary.previousValue, errors: dryRun.errors };
  }

  if (dryRun.status === "conflict" && !overrideAcknowledged) {
    await saveMessage({ proposedPatch: patch, conflicts: dryRun.wouldViolate });
    return { intent, status: "conflict", proposedPatch: patch, wouldViolate: dryRun.wouldViolate, options: dryRun.options };
  }

  // Clean, or a conflict the user explicitly acknowledged overriding (§11.4
  // guard #4: overrideAcknowledged is recorded on the version, tied to who did it).
  const newVersion = await versionService.createVersion(id, dryRun.candidateLabelData, {
    changeSource: "ai_chat_edit",
    changedByUserId: userId,
    changeSummary: patch.rationale,
    overrideAcknowledged: dryRun.status === "conflict" && overrideAcknowledged,
  });

  const finalReport = dryRun.report || (await validate(dryRun.candidateLabelData, { rules, includePlausibility: false }));
  await prisma.validationReport.create({
    data: {
      labelId: id,
      versionNumber: newVersion.versionNumber,
      passed: finalReport.passed,
      errorCount: finalReport.errorCount,
      warningCount: finalReport.warningCount,
      verdicts: finalReport.verdicts,
      coveragePercent: finalReport.coveragePercent,
      engineVersion: finalReport.engineVersion,
      rulesetIds: finalReport.rulesetIds,
      aiAssisted: finalReport.aiAssisted,
    },
  });
  await prisma.generatedLabel.update({ where: { id }, data: { status: finalReport.passed ? "validated" : "failed_validation" } });
  await recordOutcomes(rules, finalReport.verdicts, { labelId: id, discriminants: label.generationMeta?.discriminants });
  await saveMessage({ appliedPatch: patch, resultVersion: newVersion.versionNumber });

  return { intent, status: "applied", resultVersion: newVersion.versionNumber, report: finalReport };
};

export const getChatHistory = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  return prisma.labelChatMessage.findMany({ where: { labelId: id }, orderBy: { createdAt: "asc" } });
};

/**
 * PATCH /labels/:id — a direct edit, no AI involved. Same guards as chat's
 * edit path (dry-run, conflict detection, optimistic lock) minus intent
 * classification and patch proposal — the caller supplies the patch directly.
 */
export const applyDirectPatch = async (id, { changes, rationale, expectedVersion, overrideAcknowledged = false, userId, companyId } = {}) => {
  const { label, report } = await loadLabelForChat(id, companyId);

  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== label.currentVersion) {
    throw new AppError(`Version conflict: expected ${expectedVersion}, label is now at ${label.currentVersion}. Reload before editing.`, 409);
  }

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  const patch = { rationale: rationale || "Manual edit", changes };
  const dryRun = await dryRunPatch(label.labelData, report, patch, { rules });

  // See chat()'s identical comment: a refused patch is a normal outcome, not
  // an HTTP error.
  if (dryRun.status === "invalid") {
    const primary = dryRun.errors[0] || { path: null, reason: "Patch rejected.", previousValue: undefined };
    return { status: "refused", path: primary.path, reason: primary.reason, previousValue: primary.previousValue, errors: dryRun.errors };
  }
  if (dryRun.status === "conflict" && !overrideAcknowledged) {
    return { status: "conflict", wouldViolate: dryRun.wouldViolate, options: dryRun.options };
  }

  // Clean, or a conflict the caller explicitly acknowledged overriding (same
  // guard as chat's edit path — the override is recorded on the version, tied
  // to who made it, never applied silently).
  const newVersion = await versionService.createVersion(id, dryRun.candidateLabelData, {
    changeSource: "manual_edit",
    changedByUserId: userId,
    changeSummary: rationale || "Manual edit",
    overrideAcknowledged: dryRun.status === "conflict" && overrideAcknowledged,
  });
  await prisma.validationReport.create({
    data: {
      labelId: id,
      versionNumber: newVersion.versionNumber,
      passed: dryRun.report.passed,
      errorCount: dryRun.report.errorCount,
      warningCount: dryRun.report.warningCount,
      verdicts: dryRun.report.verdicts,
      coveragePercent: dryRun.report.coveragePercent,
      engineVersion: dryRun.report.engineVersion,
      rulesetIds: dryRun.report.rulesetIds,
      aiAssisted: dryRun.report.aiAssisted,
    },
  });
  await prisma.generatedLabel.update({ where: { id }, data: { status: dryRun.report.passed ? "validated" : "failed_validation" } });
  await recordOutcomes(rules, dryRun.report.verdicts, { labelId: id, discriminants: label.generationMeta?.discriminants });

  return { status: "applied", resultVersion: newVersion.versionNumber, report: dryRun.report };
};

/**
 * §11.4 guard #6: restoring version K forward-only appends N+1 (versionService
 * already implements this, Phase 1) — this wraps it with tenant scoping and a
 * fresh ValidationReport for the restored content.
 */
export const restoreVersion = async (id, versionNumber, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  const restored = await versionService.restore(id, Number(versionNumber));

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  const report = await validate(restored.labelData, { rules, includePlausibility: false });
  await prisma.validationReport.create({
    data: {
      labelId: id,
      versionNumber: restored.versionNumber,
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
  await prisma.generatedLabel.update({ where: { id }, data: { status: report.passed ? "validated" : "failed_validation" } });
  await recordOutcomes(rules, report.verdicts, { labelId: id, discriminants: label.generationMeta?.discriminants });

  return { version: restored, report };
};

export const getVersion = async (id, versionNumber, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  const version = await prisma.labelVersion.findUnique({ where: { labelId_versionNumber: { labelId: id, versionNumber: Number(versionNumber) } } });
  if (!version) throw new AppError(`Version ${versionNumber} not found for this label`, 404);
  return version;
};

export const diffVersions = async (id, a, b, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  const [versionA, versionB] = await Promise.all([
    prisma.labelVersion.findUnique({ where: { labelId_versionNumber: { labelId: id, versionNumber: Number(a) } } }),
    prisma.labelVersion.findUnique({ where: { labelId_versionNumber: { labelId: id, versionNumber: Number(b) } } }),
  ]);
  if (!versionA || !versionB) throw new AppError("One or both versions not found for this label", 404);
  return versionService.diff(versionA.labelData, versionB.labelData);
};

/**
 * §14.5.3: GET /labels/:id/extraction — returns extraction metadata and source file reference
 */
export const getExtraction = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }
  return {
    origin: label.origin,
    extractionMeta: label.extractionMeta,
    sourceFileRef: label.sourceFileRef,
  };
};

/**
 * §14.5.3: POST /labels/:id/confirm-field — human confirmation of a low-confidence/ambiguous field
 */
export const confirmField = async (id, { path, value, expectedVersion, userId, companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }

  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== label.currentVersion) {
    throw new AppError(`Version conflict: expected ${expectedVersion}, label is now at ${label.currentVersion}. Reload before confirming.`, 409);
  }

  if (!path) throw new AppError("Path is required for confirming a field", 400);

  // A confirmation that writes nothing is not a confirmation — it's silent
  // data loss on regulated content. Reject missing/undefined/empty outright
  // rather than let it overwrite a real value in labelData.
  const isEmptyValue =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "");
  if (isEmptyValue) {
    throw new AppError("A non-empty value is required to confirm this field", 400);
  }

  // Deep clone labelData and update path with confirmed value
  const newLabelData = JSON.parse(JSON.stringify(label.labelData));
  const keys = path.split(".");
  let curr = newLabelData;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!curr[keys[i]]) curr[keys[i]] = {};
    curr = curr[keys[i]];
  }
  curr[keys[keys.length - 1]] = value;

  // Update extractionMeta. Human confirmation and machine confidence are
  // different facts: confirmedByUser is what supersedes the verdict, so the
  // original extractor confidence is left untouched for later measurement of
  // extraction accuracy — confirming a field must never rewrite the record of
  // how confident the extractor actually was.
  const newExtractionMeta = JSON.parse(JSON.stringify(label.extractionMeta || {}));
  const previousMeta = newExtractionMeta[path];
  newExtractionMeta[path] = {
    confidence: previousMeta?.confidence ?? null,
    snippet: typeof value === "object" && value?.translations ? Object.values(value.translations)[0] : String(value),
    bbox: previousMeta?.bbox || null,
    ambiguous: false,
    confirmedByUser: true,
    confirmedValue: value,
    confirmedAt: new Date().toISOString(),
  };

  const newVersion = await versionService.createVersion(id, newLabelData, {
    changeSource: "manual_edit",
    changedByUserId: userId,
    changeSummary: `Confirmed field "${path}"`,
  });

  const rules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });
  const report = await validate(newLabelData, {
    rules,
    extractionMeta: newExtractionMeta,
    includePlausibility: false,
  });

  await prisma.validationReport.create({
    data: {
      labelId: id,
      versionNumber: newVersion.versionNumber,
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

  await prisma.generatedLabel.update({
    where: { id },
    data: {
      status: report.passed ? "validated" : "failed_validation",
      extractionMeta: newExtractionMeta,
    },
  });

  await recordOutcomes(rules, report.verdicts, { labelId: id, discriminants: label.generationMeta?.discriminants });

  return { label: newLabelData, version: newVersion.versionNumber, report, extractionMeta: newExtractionMeta };
};

