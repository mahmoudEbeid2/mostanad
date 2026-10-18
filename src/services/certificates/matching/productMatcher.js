import { prisma } from "../../../lib/prisma.js";

// Invoice line → catalogue product (CERTIFICATES_V2_PLAN.md §9.2). Always
// tenant-scoped (`where: { companyId }`, never a global product):
//  1. exact, case-insensitive productCode            → matched (exact_code)
//  2. exact normalised name with a single hit         → matched (exact_name)
//  3. otherwise top-5 ranked candidates               → needs_match
// A line the user matched or ignored by hand is never re-matched.

/** trimmed, case-folded, whitespace-collapsed, punctuation-stripped */
export const normalizeName = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCode = (s) => String(s || "").trim().toLowerCase();

function trigrams(s) {
  const t = `  ${s} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Trigram similarity (Jaccard), 0–1 — the same idea as pg_trgm's similarity(). */
export function similarity(a, b) {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

const CANDIDATES = 5;
const MIN_SCORE = 0.15;
const BRAND_BONUS = 0.1;

/**
 * Pure matching of one line against the company's products.
 * line: { name, code } · products: [{ id, name, productCode, brandId }] · brandId: invoice hint
 * → { productId, matchStatus, matchMethod, matchCandidates }
 */
export function matchLine(line, products, { brandId = null } = {}) {
  const code = normalizeCode(line.code);
  if (code) {
    const hits = products.filter((p) => normalizeCode(p.productCode) === code);
    if (hits.length === 1) return { productId: hits[0].id, matchStatus: "matched", matchMethod: "exact_code", matchCandidates: null };
  }
  const name = normalizeName(line.name);
  if (name) {
    const hits = products.filter((p) => normalizeName(p.name) === name);
    if (hits.length === 1) return { productId: hits[0].id, matchStatus: "matched", matchMethod: "exact_name", matchCandidates: null };
  }
  const ranked = products
    .map((p) => {
      const reasons = [];
      const nameSim = similarity(name, normalizeName(p.name));
      const codeSim = code && p.productCode ? similarity(code, normalizeCode(p.productCode)) : null;
      let score = codeSim === null ? nameSim : 0.7 * nameSim + 0.3 * codeSim;
      if (nameSim > 0) reasons.push(`name ${Math.round(nameSim * 100)}%`);
      if (codeSim) reasons.push(`code ${Math.round(codeSim * 100)}%`);
      if (code && normalizeCode(p.productCode) === code) reasons.push("same code (several products)");
      if (name && normalizeName(p.name) === name) reasons.push("same name (several products)");
      if (brandId && p.brandId === brandId) {
        score += BRAND_BONUS;
        reasons.push("invoice brand");
      }
      return { productId: p.id, name: p.name, code: p.productCode || null, score: Math.round(Math.min(score, 1) * 1000) / 1000, reasons };
    })
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES);
  return { productId: null, matchStatus: "needs_match", matchMethod: null, matchCandidates: ranked };
}

/** Re-matches every automatically-matched / unmatched line of an invoice. → { matched, needsMatch } */
export async function matchInvoice(invoiceId) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  const products = await prisma.product.findMany({
    where: { companyId: invoice.companyId },
    select: { id: true, name: true, productCode: true, brandId: true },
  });
  const auto = invoice.items.filter((it) => it.matchStatus !== "ignored" && it.matchMethod !== "user");
  const updates = auto.map((it) => ({ id: it.id, ...matchLine(it.data || {}, products, { brandId: invoice.brandId }) }));
  await prisma.$transaction(
    updates.map(({ id, matchCandidates, ...rest }) => prisma.invoiceItem.update({ where: { id }, data: { ...rest, matchCandidates: matchCandidates || [] } }))
  );
  return {
    matched: updates.filter((u) => u.matchStatus === "matched").length,
    needsMatch: updates.filter((u) => u.matchStatus === "needs_match").length,
  };
}
