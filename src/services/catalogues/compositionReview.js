import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { compareAmounts } from "./compositionCompare.js";

// Sources that disagree on an ingredient (client workflow §2.5): BOTH originals are kept, compared
// on one basis for the reviewer ("10 mg vs 640 mg per 100 mL"), and the reviewer's decision, reason
// and source are recorded. Nothing changes the product's value until a person decides.
//   product.compositionReview = { conflicts: [{ ingredient, values: [{ amountRaw, basis, source }], comparison, decision? }] }

const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The incoming composition vs the product's: → the new conflicts (also saved) */
export async function recordConflicts(product, incoming) {
  const have = Array.isArray(product.activeIngredients) ? product.activeIngredients : [];
  const review = { conflicts: [...(product.compositionReview?.conflicts || [])] };
  const added = [];
  for (const x of incoming.ingredients || []) {
    const mine = have.find((h) => key(h.name) === key(x.name));
    if (!mine) continue;
    const a = { amountRaw: mine.amountRaw ?? mine.concentration ?? null, basis: mine.basis ?? product.compositionBasis ?? null, source: product.fieldProvenance?.activeIngredients || null };
    const b = { amountRaw: x.amountRaw, basis: incoming.basis ?? null, source: incoming.source || null };
    if (String(a.amountRaw).replace(/\s+/g, "") === String(b.amountRaw).replace(/\s+/g, "") && key(a.basis) === key(b.basis)) continue;
    const cmp = compareAmounts({ amount: a.amountRaw, basis: a.basis }, { amount: b.amountRaw, basis: b.basis });
    if (cmp?.same) continue;
    if (review.conflicts.some((c) => key(c.ingredient) === key(x.name) && !c.decision && c.values.some((v) => v.amountRaw === b.amountRaw))) continue;
    const c = { ingredient: mine.name, values: [a, b], comparison: cmp ? cmp.text : null, comparable: !!cmp, at: new Date().toISOString(), decision: null };
    review.conflicts.push(c);
    added.push(c);
  }
  if (added.length) await prisma.product.update({ where: { id: product.id }, data: { compositionReview: review } });
  return added;
}

async function load(productId, companyId) {
  const p = await prisma.product.findFirst({ where: { id: productId, ...(companyId ? { companyId } : {}) } });
  if (!p) throw new AppError("Product not found!", 404);
  return p;
}

/** GET /products/:id/composition-review */
export async function getReview(productId, companyId) {
  const p = await load(productId, companyId);
  return { productId: p.id, compositionBasis: p.compositionBasis, packaging: p.packaging, conflicts: (p.compositionReview?.conflicts || []).map((c, index) => ({ index, ...c })) };
}

/**
 * POST /products/:id/composition-review/:index/decide { chosen: 0 | 1, reason } — the reviewer picks
 * the value used for issue (the manufacturer's confirmed formulation). Both values stay recorded.
 */
export async function decide(productId, companyId, index, { chosen, reason }, userId) {
  const p = await load(productId, companyId);
  const conflicts = [...(p.compositionReview?.conflicts || [])];
  const c = conflicts[index];
  if (!c) throw new AppError("That disagreement doesn't exist", 404);
  if (![0, 1].includes(chosen)) throw new AppError("chosen must be 0 or 1", 400);
  if (!String(reason || "").trim()) throw new AppError("Say why (the reason is recorded)", 400);
  const v = c.values[chosen];
  conflicts[index] = { ...c, decision: { chosen, amountRaw: v.amountRaw, basis: v.basis, reason: String(reason).trim().slice(0, 500), byUserId: userId || null, at: new Date().toISOString() } };
  const ingredients = (Array.isArray(p.activeIngredients) ? p.activeIngredients : []).map((i) => (key(i.name) === key(c.ingredient) ? { ...i, amountRaw: v.amountRaw, concentration: v.amountRaw, basis: v.basis ?? i.basis } : i));
  await prisma.product.update({
    where: { id: p.id },
    data: { activeIngredients: ingredients, compositionReview: { conflicts }, fieldProvenance: { ...(p.fieldProvenance || {}), activeIngredients: { tier: "manual", decidedConflict: c.ingredient, reason: conflicts[index].decision.reason, by: userId || null, at: conflicts[index].decision.at, source: v.source || null } } },
  });
  return getReview(p.id, companyId);
}
