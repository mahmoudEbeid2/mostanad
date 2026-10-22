import { prisma } from "../../../lib/prisma.js";
import { getAiSettings } from "../ai/aiSettings.js";
import { aliasMap, rememberAlias } from "./productAliases.js";
import { aiMatch, AI_CANDIDATES } from "./aiMatcher.js";

// Invoice line → catalogue product (CERTIFICATES_V2_PLAN.md §9.2, plan.md §7).
// Always tenant-scoped (`where: { companyId }`, never a global product). Each
// step stops on a single confident hit:
//  1. a learned alias of the line's name (ProductAlias) → matched (alias)
//  2. exact, case-insensitive productCode            → matched (exact_code)
//  3. exact normalised name with a single hit         → matched (exact_name)
//  4. otherwise top-5 ranked candidates               → needs_match
//  5. ONE AI call for the lines still ambiguous (aiMatcher): its pick of the
//     line's top-10 candidates is a suggestion — matched (ai_confirmed) only
//     when the company auto-accepts at/above its threshold, else shown first
//     among the candidates for a person to confirm.
// A line the user matched or ignored by hand (or confirmed an AI pick for) is never re-matched.

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

const CANDIDATES = 5; // shown to the user
export const KEPT_METHODS = ["user", "ai_confirmed"]; // a person's decision — re-matching leaves them alone
const MIN_SCORE = 0.15;
const BRAND_BONUS = 0.1;

/**
 * Pure matching of one line against the company's products.
 * line: { name, code } · products: [{ id, name, productCode, brandId }] · brandId: invoice hint
 * → { productId, matchStatus, matchMethod, matchCandidates }
 */
export function matchLine(line, products, { brandId = null, aliases = null } = {}) {
  const alias = aliases?.get(normalizeName(line.name));
  if (alias && products.some((p) => p.id === alias)) return { productId: alias, matchStatus: "matched", matchMethod: "alias", matchCandidates: null };
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
    .slice(0, AI_CANDIDATES);
  return { productId: null, matchStatus: "needs_match", matchMethod: null, matchCandidates: ranked.slice(0, CANDIDATES), aiCandidates: ranked.map((c) => c.productId) };
}

/**
 * Re-matches every automatically-matched / unmatched line of an invoice.
 * → { matched, needsMatch, ai: { used, calls, reused, asked, suggested, autoAccepted, unavailable?, reason? } }
 * deps.generate replaces the model call (tests).
 */
export async function matchInvoice(invoiceId, { generate } = {}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  const products = await prisma.product.findMany({
    where: { companyId: invoice.companyId },
    select: { id: true, name: true, productCode: true, brandId: true, packaging: true, strength: true, physicalForm: true, dosageForm: true, targetSpecies: true, brand: { select: { name: true } } },
  });
  const aliases = await aliasMap(invoice.companyId);
  const auto = invoice.items.filter((it) => it.matchStatus !== "ignored" && !KEPT_METHODS.includes(it.matchMethod));
  const updates = auto.map((it) => ({ id: it.id, item: it, ...matchLine(it.data || {}, products, { brandId: invoice.brandId, aliases }) }));

  const pending = updates.filter((u) => u.matchStatus === "needs_match" && u.aiCandidates?.length).map((u) => ({ item: u.item, candidates: u.aiCandidates }));
  const settings = await getAiSettings(invoice.companyId);
  const { picks, ai } = await aiMatch(invoice, pending, new Map(products.map((p) => [p.id, p])), settings, { generate });
  ai.suggested = 0;
  ai.autoAccepted = 0;
  for (const u of updates) {
    const pick = picks.get(u.id);
    if (!pick) continue;
    if (pick.autoAccepted) {
      Object.assign(u, { productId: pick.productId, matchStatus: "matched", matchMethod: "ai_confirmed", matchCandidates: null });
      await rememberAlias(invoice.companyId, u.item.data?.name, pick.productId, "ai_confirmed");
      ai.autoAccepted++;
    } else {
      // the AI's pick first, marked, for a person to confirm (plan.md §7 "AI suggests X (0.78) — confirm")
      const p = products.find((x) => x.id === pick.productId);
      const rest = (u.matchCandidates || []).filter((c) => c.productId !== pick.productId);
      const base = (u.matchCandidates || []).find((c) => c.productId === pick.productId) || { productId: p.id, name: p.name, code: p.productCode || null, score: null, reasons: [] };
      u.matchCandidates = [{ ...base, ai: { suggestionId: pick.suggestion.id, confidence: Math.round(pick.confidence * 100) / 100, reasons: pick.reasons } }, ...rest].slice(0, CANDIDATES);
      ai.suggested++;
    }
  }
  await prisma.$transaction(
    updates.map(({ id, matchCandidates, productId, matchStatus, matchMethod }) => prisma.invoiceItem.update({ where: { id }, data: { productId, matchStatus, matchMethod, matchCandidates: matchCandidates || [] } }))
  );
  return {
    matched: updates.filter((u) => u.matchStatus === "matched").length,
    needsMatch: updates.filter((u) => u.matchStatus === "needs_match").length,
    ai,
  };
}
