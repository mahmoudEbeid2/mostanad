import AppError from "../../utils/appError.js";
import { scopeFor } from "../../utils/tenantScope.js";

// Tenant resolution for every Certificates V2 route (plan §12): a company
// caller is forced to its own id; a system user names the company with
// ?companyId= (or body.companyId on create).

/** The company a create/list call acts on — required. */
export function companyFor(req) {
  if (req.company) return req.company.id;
  const id = req.query?.companyId || req.body?.companyId;
  if (!id) throw new AppError("companyId is required (pass ?companyId= as a system user)", 400);
  return id;
}

/** Scope for by-id calls: a company id, or undefined for an unscoped system user. */
export const scopeOf = (req) => scopeFor(req);

export const actorId = (req) => req.user?.id || null;

export const CERT_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
};
