import { prisma } from "../../../lib/prisma.js";
import { canonicalFull, fromSource } from "../paths/sourcePath.js";
import { hardNever } from "../inference/policy.js";

// A product's certificate profile (owner, 2026-10-24, item 3): the product values
// certificates needed, kept per product so the next invoice reads them by code —
// no gap call, no inference, no web lookup. Written when a value was proven by a
// verbatim quote (filled directly) or a person confirmed / typed it. A person's
// value is never overwritten by an automatic one.
// Never for a lab result, an invoice / batch value, a date or a quantity: only
// what may be a product fact at all (the policy's hard line decides).

const normLabel = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Fields whose values can belong to a product's profile. */
export const profileAllowed = (field) => !!field && !hardNever(field);

/** The profile key: the field's product path when it reads one, else its label. */
export function profileKey(field) {
  if (field?.source?.kind === "product" && field.source.path) {
    const full = canonicalFull(fromSource(field.source));
    if (full) return `path:${full}`;
  }
  return `label:${normLabel(field?.label)}`;
}

/** productIds → Map(productId → Map(key → row)), one company only. */
export async function loadProfiles(companyId, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return out;
  const rows = await prisma.productCertificateValue.findMany({ where: { companyId, productId: { in: ids } } });
  for (const r of rows) out.get(r.productId)?.set(r.key, r);
  return out;
}

/** The profile row a field reads for a product, or null. */
export const profileValue = (profiles, productId, field) => (profileAllowed(field) ? profiles?.get(productId)?.get(profileKey(field)) || null : null);

/**
 * Remembers a product value. userId set = a person confirmed / typed it (wins over
 * everything); without one = filled directly from verified evidence (never replaces
 * a person's value). → the row, or null when not allowed / not written.
 */
export async function rememberValue({ companyId, productId, field, value, provenance, estimated = false, userId = null, invoiceId = null }) {
  if (!companyId || !productId || !profileAllowed(field)) return null;
  const v = String(value ?? "").trim();
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { aiSettings: true } });
  if (company?.aiSettings?.rememberProductValues === false) return null;
  if (!v) return null;
  // tenant guard: the product must be the company's own
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) return null;
  const key = profileKey(field);
  const existing = await prisma.productCertificateValue.findUnique({ where: { companyId_productId_key: { companyId, productId, key } } });
  if (existing?.confirmedByUserId && !userId) return existing;
  const data = {
    label: String(field.label || key).slice(0, 200),
    value: v.slice(0, 2000),
    provenance: provenance || { kind: "manual" },
    estimated: !!estimated,
    confirmedByUserId: userId,
    confirmedAt: userId ? new Date() : null,
    sourceInvoiceId: invoiceId,
  };
  return prisma.productCertificateValue.upsert({ where: { companyId_productId_key: { companyId, productId, key } }, create: { companyId, productId, key, ...data }, update: data });
}

/** GET /certificate-products/:id/profile → rows, newest first (tenant-scoped). */
export async function listProfile(companyId, productId) {
  return prisma.productCertificateValue.findMany({ where: { companyId, productId }, orderBy: { updatedAt: "desc" } });
}

/** DELETE /certificate-product-values/:id — forget one value (the next invoice fills it again). */
export async function forgetValue(companyId, id) {
  const r = await prisma.productCertificateValue.deleteMany({ where: { id, companyId } });
  return r.count === 1;
}
