import AppError from "../../utils/appError.js";
import { scopeFor } from "../../utils/tenantScope.js";
import { companyMayUse } from "../../middleware/authMiddleware.js";
import { isBypassed } from "../../middleware/testBypass.js";

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

/** Whether the caller holds a permission beyond the route's own — the same rule restrictToPermission applies. */
export function mayDo(req, slug) {
  if (isBypassed(req)) return true;
  if (req.company) return companyMayUse(slug);
  return (req.user?.role?.permissions || []).some((rp) => rp.permission?.slug === slug);
}

export const CERT_HTML_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

export const CERT_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": CERT_HTML_CSP,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
};

// The header does not reach a frame the UI fills via srcdoc / document.write
// (about:blank), so the same policy also travels inside the document (review
// #3) — first thing in <head>, before anything it has to govern. Added on the
// way out only; the stored file is untouched.
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CERT_HTML_CSP}">`;

export function withCspMeta(html) {
  const s = String(html ?? "");
  const head = /<head(?=[\s>])[^>]*>/i;
  const root = /<html(?=[\s>])[^>]*>/i;
  if (head.test(s)) return s.replace(head, (m) => m + CSP_META);
  if (root.test(s)) return s.replace(root, (m) => `${m}<head>${CSP_META}</head>`);
  const doctype = s.match(/^\s*<!doctype[^>]*>/i)?.[0] || "";
  return `${doctype}<head>${CSP_META}</head>${s.slice(doctype.length)}`;
}

export const sendCertHtml = (res, html) => res.set(CERT_HTML_HEADERS).status(200).send(withCspMeta(html));
