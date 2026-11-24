import { prisma } from "../lib/prisma.js";

// A brand name as printed on a label or typed by a person ("Max Vet", "MAXVET®",
// "maxvet") matched against one company's brands. Case, spaces, punctuation and
// ®/™ don't count; one letter off (or two in a long name) is still a match.
// Used where a brand has to be recognised: a reference label being read, the
// assistant's list_brands.

/** "MAX-VET®" → "maxvet" */
export const brandKey = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How well `text` names `brandName`: 1 the same name, 0.9 one contains the
 * other (a brand word inside "MAXVET Supplement Product"), 0.8 one or two
 * letters off; 0 no match. Names shorter than 3 letters only match exactly.
 */
export function brandScore(text, brandName) {
  const a = brandKey(text);
  const b = brandKey(brandName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 3) return 0;
  if (b.length >= 4 && a.includes(b)) return 0.9;
  if (a.length >= 4 && b.includes(a)) return 0.9;
  const d = editDistance(a, b);
  if (d === 1 && b.length >= 4) return 0.8;
  if (d === 2 && b.length >= 8) return 0.8;
  return 0;
}

/**
 * The company's brands that `text` names, best first → [{ id, name, isActive, score }].
 * `brands` can be passed in (tests, or a list already loaded).
 */
export async function matchBrands(companyId, text, { brands } = {}) {
  if (!text || !String(text).trim()) return [];
  const list = brands || (await prisma.brand.findMany({ where: { companyId }, select: { id: true, name: true, isActive: true } }));
  return list
    .map((b) => ({ id: b.id, name: b.name, isActive: b.isActive, score: brandScore(text, b.name) }))
    .filter((b) => b.score > 0)
    .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
}

/**
 * The one brand a label names, if it is clear: a single best match (an exact
 * name beats contains / near). → { brandId | null, printed, candidates }
 * Several equally good → brandId null, the candidates are the choices.
 */
export async function resolveBrand(companyId, printed, opts) {
  const candidates = await matchBrands(companyId, printed, opts);
  const best = candidates.filter((c) => c.score === candidates[0]?.score);
  return { brandId: best.length === 1 ? best[0].id : null, printed: printed || null, candidates: candidates.map(({ id, name, score }) => ({ id, name, score })) };
}
