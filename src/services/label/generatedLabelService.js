import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { validate } from "./validation/validationEngine.js";

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

  const report = validate(label.labelData, { rules: [] });

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
