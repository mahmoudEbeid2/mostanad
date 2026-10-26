import { prisma } from "../../../lib/prisma.js";
import { sha16, stableStringify } from "../ai/aiRunLog.js";
import { profileAllowed, profileKey } from "./productProfile.js";

// "Asked, came back empty" (owner, 2026-10-27): a product fact the AI step (the gap call "G" or
// inference "I") was asked for and didn't deliver a usable value is not asked again for the same
// company + product + field — on any later invoice — until the product's data changes. The entry
// keeps a fingerprint of the product (its record and its linked catalogue block); a different
// fingerprint means the data changed, so the step may ask again.
// Product facts only: lab results and invoice / batch values are never cached here (a new invoice
// may print them). Stored in external_knowledge_cache, kind cert_gap_not_found, tenant in the key.

export const NEGATIVE_KIND = "cert_gap_not_found";
const VOLATILE = new Set(["createdAt", "updatedAt", "brand", "category"]);

/** The product's data as the AI steps see it → a short hash. */
export function productFingerprint(product, block = null) {
  if (!product) return null;
  const data = Object.fromEntries(Object.entries(product).filter(([k]) => !VOLATILE.has(k)));
  return sha16(stableStringify({ data, block: block ? { id: block.id, versionId: block.versionId, text: block.text } : null }));
}

const keyOf = (companyId, productId, step, field) => `${companyId}|${productId}|${step}|${profileKey(field)}`;

/** May this field be remembered as "came back empty"? (a product fact only) */
export const cacheable = (field, productId) => !!productId && profileAllowed(field);

/** → Set of lookup keys already known empty for these (product, field) pairs, with the current fingerprints. */
export async function knownEmpty(companyId, step, pairs) {
  const wanted = pairs.filter((p) => cacheable(p.field, p.productId));
  if (!wanted.length) return new Set();
  const keys = [...new Set(wanted.map((p) => keyOf(companyId, p.productId, step, p.field)))];
  const rows = await prisma.externalKnowledgeCache.findMany({ where: { kind: NEGATIVE_KIND, lookupKey: { in: keys } } });
  const byKey = new Map(rows.map((r) => [r.lookupKey, r]));
  const out = new Set();
  for (const p of wanted) {
    const k = keyOf(companyId, p.productId, step, p.field);
    if (byKey.get(k)?.payload?.fingerprint === p.fingerprint) out.add(k);
  }
  return out;
}

export const isKnownEmpty = (known, companyId, step, productId, field) => known.has(keyOf(companyId, productId, step, field));

/** Remembers that `step` came back empty for this product + field, at this fingerprint. */
export async function rememberEmpty(companyId, step, productId, field, fingerprint, { invoiceId = null, reason = null } = {}) {
  if (!cacheable(field, productId) || !fingerprint) return null;
  const lookupKey = keyOf(companyId, productId, step, field);
  const data = {
    payload: { fingerprint, step, productId, label: field.label, invoiceId, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) },
    summary: `${field.label}: not found (${step === "I" ? "inference" : "gap call"})`,
    sourceType: "none",
    sourceUrls: [],
    confidence: "low",
    status: "unreviewed",
    retrievedAt: new Date(),
    expiresAt: null, // until the product changes, not until a date
  };
  return prisma.externalKnowledgeCache.upsert({ where: { kind_lookupKey: { kind: NEGATIVE_KIND, lookupKey } }, create: { kind: NEGATIVE_KIND, lookupKey, ...data }, update: data });
}
