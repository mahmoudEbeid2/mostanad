import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { normalizeName } from "../certificates/matching/productMatcher.js";
import { searchCatalogues } from "../catalogues/searchService.js";

// Product search for the assistant (C1). The invoice matching layers, in order:
//   1. exact product code (case-insensitive)          score 1.00
//   2. a saved alias (ProductAlias, normalised name)   score 0.95
//   3. trigram name similarity (pg_trgm)               score ≤ 0.90
//   4. catalogue full text (catalogue blocks linked
//      to a product)                                   score ≤ 0.60
// Several spellings (Arabic, English, close spellings) are searched together and
// merged per product, keeping the best score. Always scoped: one company, or —
// for a system user with "All companies" only — every company, with the company
// named on each result. The plain products list (ILIKE) is not touched.

const TOP = 5;
const MIN_TRGM = 0.2;
// Arabic spelling variants folded before comparing (alef forms, taa marbuta, alef maqsura)
const FOLD_FROM = "أإآٱةى";
const FOLD_TO = "ااااهي";
const TASHKEEL = "[ً-ْ]"; // short-vowel marks
const fold = (s) => [...String(s || "").toLowerCase()].map((c) => (FOLD_FROM.includes(c) ? FOLD_TO[FOLD_FROM.indexOf(c)] : c)).join("").replace(new RegExp(TASHKEEL, "g"), "").replace(/\s+/g, " ").trim();
const NAME_SQL = Prisma.sql`regexp_replace(translate(lower(p."name"), ${FOLD_FROM}, ${FOLD_TO}), ${TASHKEEL}, '', 'g')`;

const companyWhere = (companyId) => (companyId ? { companyId } : {});

/**
 * → { verdict: "clear"|"ambiguous"|"none", results: [{ productId, name, productCode, brand, company?, score, via[], matchedQuery, snippet? }], notes[] }
 */
export async function searchProductsForAssistant({ companyId = null, queries = [], limit = TOP }) {
  const terms = [...new Set(queries.map((q) => String(q || "").trim()).filter((q) => q.length >= 2))].slice(0, 6);
  const notes = [];
  if (!terms.length) return { verdict: "none", results: [], notes: ["Give at least one name or code of 2+ characters."] };
  const hits = new Map(); // productId → { score, via:Set, matchedQuery, snippet }
  const add = (productId, score, via, q, extra = {}) => {
    if (!productId) return;
    const h = hits.get(productId) || { score: 0, via: new Set(), matchedQuery: q };
    h.via.add(via);
    if (score > h.score) Object.assign(h, { score, matchedQuery: q, ...extra });
    hits.set(productId, h);
  };

  for (const q of terms) {
    const codes = await prisma.product.findMany({ where: { ...companyWhere(companyId), productCode: { equals: q, mode: "insensitive" } }, select: { id: true } });
    for (const p of codes) add(p.id, 1, "code", q);

    const aliases = await prisma.productAlias.findMany({ where: { ...companyWhere(companyId), aliasNorm: normalizeName(q) }, select: { productId: true } });
    for (const a of aliases) add(a.productId, 0.95, "alias", q);

    const f = fold(q);
    const rows = await prisma.$queryRaw`
      SELECT p."id", greatest(similarity(${NAME_SQL}, ${f}), word_similarity(${f}, ${NAME_SQL})) AS "sim",
             (${NAME_SQL} LIKE ${"%" + f + "%"}) AS "contains"
      FROM "products" p
      WHERE ${companyId ? Prisma.sql`p."company_id" = ${companyId}` : Prisma.sql`true`}
        AND (${NAME_SQL} % ${f} OR ${f} <% ${NAME_SQL} OR ${NAME_SQL} LIKE ${"%" + f + "%"})
      ORDER BY 2 DESC
      LIMIT 20`;
    for (const r of rows) {
      const sim = Number(r.sim) || 0;
      const score = r.contains ? Math.max(0.8, 0.9 * sim) : 0.9 * sim;
      if (score >= MIN_TRGM * 0.9) add(r.id, Math.round(score * 1000) / 1000, "name", q);
    }

    if (companyId) {
      try {
        const { results } = await searchCatalogues(companyId, q, { limit: 10 });
        for (const b of results) if (b.productId) add(b.productId, b.match === "phrase" ? 0.6 : b.match === "words" ? 0.5 : 0.4, "catalogue", q, { snippet: b.snippet ? b.snippet.slice(0, 200) : null, cataloguePage: b.page });
      } catch (err) {
        if (err.code !== "QUERY_REQUIRED") throw err;
      }
    }
  }
  if (!companyId) notes.push("Catalogue text was not searched: it needs one company.");

  const ranked = [...hits.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, Math.min(Math.max(1, limit), 10));
  const products = await prisma.product.findMany({
    where: { id: { in: ranked.map(([id]) => id) }, ...companyWhere(companyId) },
    select: { id: true, name: true, productCode: true, brand: { select: { name: true } }, company: { select: { id: true, name: true } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const results = ranked
    .filter(([id]) => byId.has(id))
    .map(([id, h]) => {
      const p = byId.get(id);
      return {
        productId: id,
        name: p.name,
        productCode: p.productCode || null,
        brand: p.brand?.name || null,
        ...(companyId ? {} : { company: p.company.name, companyId: p.company.id }),
        score: h.score,
        via: [...h.via],
        matchedQuery: h.matchedQuery,
        ...(h.snippet ? { snippet: h.snippet, cataloguePage: h.cataloguePage } : {}),
        ref: { type: "product", id, name: p.name },
      };
    });
  return { verdict: verdictOf(results), results, notes };
}

/** One clear match / several close ones / none. */
export function verdictOf(results) {
  if (!results.length) return "none";
  const [a, b] = results;
  if (a.score >= 0.95 && (!b || b.score < 0.95)) return "clear";
  if (a.score >= 0.5 && (!b || a.score - b.score >= 0.2)) return "clear";
  return "ambiguous";
}
