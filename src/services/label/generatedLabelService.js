import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";

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
