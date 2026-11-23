import { prisma } from "../../lib/prisma.js";
import { riskScore, autonomyTierFor } from "./assurance/riskScorer.js";

// A label check ("verify label") used to leave its report only on the background
// task: no label to open, no link, so the assistant answered "I cannot show you the
// problems without a label ID" (QA 2026-11-23). The checked label is now kept like
// any uploaded label (origin "extracted", the read content and the file name), with
// its validation report, and the task result says where it is and what was found.
// Verdicts are the validation engine's — copied, never rewritten.

const STATUS_ORDER = ["FAIL", "NEEDS_REVIEW", "NEEDS_CONFIRMATION", "UNVERIFIABLE"];

/** The overall verdict of a report: PASS only when it passed with nothing to review. */
export function overallVerdict(report) {
  const statuses = new Set((report?.verdicts || []).map((v) => v.status));
  if (!report?.passed || statuses.has("FAIL")) return "FAIL";
  if (statuses.has("NEEDS_REVIEW") || statuses.has("NEEDS_CONFIRMATION") || statuses.has("UNVERIFIABLE")) return "NEEDS_REVIEW";
  return "PASS";
}

/** Up to `n` issues, worst first, as stored: { field, status, message }. */
export function topIssues(report, n = 5) {
  return (report?.verdicts || [])
    .filter((v) => v.status && !["PASS", "NOT_APPLICABLE"].includes(v.status))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    .slice(0, n)
    .map((v) => ({ field: v.path || v.fieldPath || v.field || v.ruleKey || null, status: v.status, message: v.message || v.reason || v.description || null }));
}

/**
 * verifyProductLabel's result → a stored label + validation report.
 * → { labelId, validationId, verdict, riskScore, autonomyTier, errorCount, warningCount, issues, link }
 */
export async function recordVerification(result, { companyId, country = null, fileName = null, taskId = null }) {
  if (!companyId) return null; // a label belongs to a company; an unscoped check keeps its report on the task only
  const labelData = result?.product?.extractedDetails;
  const report = result?.validation;
  if (!labelData || !report) return null;
  const score = riskScore(labelData, report, {});
  const { tier } = autonomyTierFor(score);
  const verdict = overallVerdict(report);
  const label = await prisma.generatedLabel.create({
    data: {
      companyId,
      productId: result.productMatchStatus?.state === "exact" ? result.productMatchStatus?.candidate?.id ?? null : null,
      inputPayload: { source: "label_verification", fileName, taskId },
      labelData,
      labelProvenance: {},
      schemaVersion: labelData.schemaVersion || "vet-label@2.0.0",
      country: country || "XX",
      language: "en",
      status: report.passed ? "validated" : "failed_validation",
      origin: "extracted",
      extractionMeta: result.product?.extractionMeta ?? undefined,
      riskScore: score,
      autonomyTier: tier,
    },
  });
  const saved = await prisma.validationReport.create({
    data: {
      labelId: label.id,
      versionNumber: label.currentVersion,
      passed: !!report.passed,
      errorCount: report.errorCount || 0,
      warningCount: report.warningCount || 0,
      verdicts: report.verdicts || [],
      coveragePercent: report.coveragePercent ?? null,
      engineVersion: report.engineVersion || "unknown",
      rulesetIds: report.rulesetIds || [],
      aiAssisted: !!report.aiAssisted,
    },
  });
  return {
    labelId: label.id,
    validationId: saved.id,
    verdict,
    riskScore: score,
    autonomyTier: tier,
    errorCount: saved.errorCount,
    warningCount: saved.warningCount,
    issues: topIssues(report),
    regulatoryStatus: result.regulatoryStatus?.message || result.regulatoryStatus?.status || null,
    link: `/labels/detail/${label.id}`,
  };
}
