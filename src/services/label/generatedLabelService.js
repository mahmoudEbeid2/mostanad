import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { validate } from "./validation/validationEngine.js";
import { audit, compareVerdicts } from "./validation/adversarialAuditor.js";
import { riskScore, autonomyTierFor } from "./assurance/riskScorer.js";

async function getApprovedRulesForCountry(country) {
  const documents = await prisma.regulatoryDocument.findMany({ where: { country, status: "approved" }, select: { id: true } });
  if (documents.length === 0) return [];
  return prisma.regulatoryRule.findMany({ where: { documentId: { in: documents.map((d) => d.id) }, status: "approved" } });
}

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

  const rules = await getApprovedRulesForCountry(label.country);
  const report = validate(label.labelData, { rules });

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
export const runAudit = async (id, { companyId } = {}) => {
  const label = await prisma.generatedLabel.findUnique({ where: { id } });
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No generated label found with that ID", 404);
  }

  const latestReport = await prisma.validationReport.findFirst({ where: { labelId: id }, orderBy: { createdAt: "desc" } });
  if (!latestReport) throw new AppError("This label has not been validated yet — POST /labels/:id/validate first.", 400);

  const rules = await getApprovedRulesForCountry(label.country);
  const auditorVerdicts = await audit(label.labelData, { rules, confirmedFacts: label.inputPayload });
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
