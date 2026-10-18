import AppError from "./appError.js";

/**
 * The company a request is scoped to.
 * A company caller is always forced to its own id; a system user may pass
 * ?companyId= (or nothing → unscoped admin view, where the route allows it).
 */
export const scopeFor = (req) => (req.company ? req.company.id : req.query?.companyId || undefined);

/**
 * Refuse a company caller that addresses another tenant's company id.
 * 404, never 403 — another tenant's existence is not leaked.
 */
export const assertCompanyAccess = (req, companyId, message = "Target company not found!") => {
  if (req.company && companyId !== req.company.id) {
    throw new AppError(message, 404);
  }
};

/**
 * A row is visible to the caller when the caller is unscoped (system user
 * without ?companyId=) or the row belongs to the scoped company.
 */
export const isVisibleTo = (row, companyId) => !!row && (!companyId || row.companyId === companyId);
