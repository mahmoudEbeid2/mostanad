import { prisma } from "../../lib/prisma.js";
import { normalizeName } from "../certificates/matching/productMatcher.js";

// Which existing product of the company a catalogue block stands for (plan.md
// §15.3 step 7: "by productCode first, then normalised name, within the company").
// Used by the review (A6.4: such a block is never applied there) and the
// re-upload diff (A6.5: it is applied there, field by field).
//  - A code printed for several products of this version (AKS13) is ambiguous:
//    it is never used to match — the name decides (owner rule).
//  - Several hits → the ones already linked to this catalogue win; still several → ambiguous.
//  - A product already linked to ANOTHER block of this version is "taken": two
//    blocks never write into one product.

const codeKey = (c) => String(c ?? "").trim().toUpperCase();
export const recordCode = (ex) => ex?.manual?.productCode?.value ?? ex?.record?.productCode ?? null;
export const recordName = (ex) => ex?.manual?.name?.value ?? ex?.record?.name ?? null;

/** Codes printed on two or more product blocks of the version. */
export function duplicateCodesOf(blocks) {
  const seen = new Map();
  for (const b of blocks) {
    if (b.kind !== "product" || b.status === "rejected") continue;
    const k = codeKey(recordCode(b.extracted));
    if (k) seen.set(k, (seen.get(k) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/** Everything matching needs for one version, loaded once. */
export async function matchContext(version, blocks = null) {
  const all = blocks || (await prisma.catalogueBlock.findMany({ where: { versionId: version.id }, select: { id: true, kind: true, status: true, productId: true, extracted: true } }));
  const products = await prisma.product.findMany({ where: { companyId: version.companyId }, select: { id: true, name: true, productCode: true, catalogueRef: true } });
  const taken = new Map(all.filter((b) => b.productId).map((b) => [b.productId, b.id]));
  return { catalogueId: version.catalogueId, products, duplicateCodes: duplicateCodesOf(all), taken };
}

/** → null | { productId, name, by } | { productId: null, ambiguous: [ids], by } | { …, takenByBlockId } */
export function matchBlock(ctx, block) {
  const ex = block.extracted;
  if (!ex) return null;
  const linked = (p) => p.catalogueRef?.catalogueId && p.catalogueRef.catalogueId === ctx.catalogueId;
  const decide = (hits, by) => {
    if (!hits.length) return null;
    let pick = hits;
    if (pick.length > 1) {
      const own = pick.filter(linked);
      if (own.length) pick = own;
    }
    if (pick.length > 1) return { productId: null, ambiguous: pick.map((p) => p.id), candidates: pick.map((p) => ({ id: p.id, name: p.name, productCode: p.productCode })), by };
    const p = pick[0];
    const other = ctx.taken.get(p.id);
    return { productId: p.id, name: p.name, by, ...(other && other !== block.id ? { takenByBlockId: other } : {}) };
  };
  const code = codeKey(recordCode(ex));
  if (code && !ctx.duplicateCodes.has(code)) {
    const r = decide(ctx.products.filter((p) => codeKey(p.productCode) === code), "code");
    if (r) return r;
  }
  const name = normalizeName(recordName(ex));
  return name ? decide(ctx.products.filter((p) => normalizeName(p.name) === name), "name") : null;
}
