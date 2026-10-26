import { prisma } from "../../../lib/prisma.js";
import { isLabResult } from "../inference/policy.js";

// A batch's lab results (fill automatically, item 4, owner 2026-10-26). A result is
// measured once per batch, so a value confirmed for (company, product, batch number,
// label) is reused BY CODE on every other line or invoice of that batch — no AI call.
// Only two sources may write one: a person (the results grid, or accepting / typing a
// value in the data check) and a supplier COA value code found verbatim in the document
// for that batch. Never inference, the web, a catalogue or a product profile.
// A line without a batch number has nothing to key a result by: its values stay on that
// line's needs and are never reused.

export const SOURCES = ["manual", "supplier_coa"];

/** "AV-123 / 45" → "AV12345": case, spaces and punctuation don't make another batch. */
export const normBatch = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");

/** The same label normalisation the data check groups lab results by. */
export const normLabel = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A line's batch number as printed / typed, or null. */
export const batchOf = (item) => {
  const b = String(item?.data?.batchNo ?? "").trim();
  return b && normBatch(b) ? b : null;
};

const key = (productId, batchNorm, labelNorm) => `${productId}|${batchNorm}|${labelNorm}`;

/** The company's stored results for these lines' (product, batch) pairs → Map(key → row). */
export async function loadBatchResults(companyId, items) {
  const pairs = items.filter((it) => it.productId && batchOf(it)).map((it) => ({ productId: it.productId, batchNorm: normBatch(batchOf(it)) }));
  const out = new Map();
  if (!pairs.length) return out;
  const rows = await prisma.batchResult.findMany({
    where: { companyId, productId: { in: [...new Set(pairs.map((p) => p.productId))] }, batchNorm: { in: [...new Set(pairs.map((p) => p.batchNorm))] } },
  });
  for (const r of rows) out.set(key(r.productId, r.batchNorm, r.labelNorm), r);
  return out;
}

/** The stored result a lab-result field reads on a line, or null (no batch → never). */
export function batchValue(results, item, field) {
  if (!isLabResult(field) || !item?.productId) return null;
  const batch = batchOf(item);
  if (!batch) return null;
  return results?.get(key(item.productId, normBatch(batch), normLabel(field.label))) || null;
}

/** The need provenance of a reused batch result. */
export const reusedProvenance = (row) => ({
  kind: "batch_result",
  batchResultId: row.id,
  batchNo: row.batchNo,
  source: row.source,
  fromInvoiceId: row.sourceInvoiceId,
  ...(row.provenance?.invoiceNumber ? { fromInvoiceNumber: row.provenance.invoiceNumber } : {}),
  ...(row.source === "supplier_coa" ? { coaId: row.provenance?.coaId, fileName: row.provenance?.fileName, page: row.provenance?.page, quote: row.provenance?.quote } : {}),
  confirmedByUserId: row.confirmedByUserId,
});

/**
 * Stores a batch's result. A person's value (userId) wins over everything; a supplier COA
 * value never replaces a person's. No batch number, no product, not a lab result, or a
 * source other than a person / a verified COA → nothing is written. → the row or null
 */
export async function rememberBatchResult({ companyId, item, field, label, value, source, provenance, userId = null, invoiceId = null }) {
  if (!SOURCES.includes(source)) throw new Error(`a batch result comes from a person or a supplier COA, not "${source}"`);
  if (field && !isLabResult(field)) return null;
  const batch = batchOf(item);
  const v = String(value ?? "").trim();
  if (!companyId || !item?.productId || !batch || !v) return null;
  // tenant guard: the product must be the company's own
  const product = await prisma.product.findFirst({ where: { id: item.productId, companyId }, select: { id: true } });
  if (!product) return null;
  const where = { companyId_productId_batchNorm_labelNorm: { companyId, productId: item.productId, batchNorm: normBatch(batch), labelNorm: normLabel(label ?? field?.label) } };
  const existing = await prisma.batchResult.findUnique({ where });
  if (existing?.confirmedByUserId && !userId) return existing;
  const data = {
    batchNo: batch.slice(0, 100),
    label: String(label ?? field?.label ?? "").slice(0, 200),
    value: v.slice(0, 500),
    source,
    provenance: provenance || { kind: source },
    confirmedByUserId: userId,
    sourceInvoiceId: invoiceId,
    sourceInvoiceItemId: item.id || null,
  };
  return prisma.batchResult.upsert({ where, create: { ...where.companyId_productId_batchNorm_labelNorm, ...data }, update: data });
}

/** Forget a batch's result (a person cleared it in the grid). */
export async function forgetBatchResult(companyId, item, label) {
  const batch = batchOf(item);
  if (!batch || !item?.productId) return 0;
  const r = await prisma.batchResult.deleteMany({ where: { companyId, productId: item.productId, batchNorm: normBatch(batch), labelNorm: normLabel(label) } });
  return r.count;
}
