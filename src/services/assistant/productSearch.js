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

// case-, space- and Arabic-spelling-insensitive: "AD3E +CK" = "ad3e+ck", "DOXYCOLINE - L" = "doxycoline-l"
const keyOf = (s) => fold(s).replace(/\s+/g, "");
const KEY_SQL = (col) => Prisma.sql`regexp_replace(${col}, '[[:space:]]+', '', 'g')`;
// a name like "DCP 18%" must not turn into a LIKE wildcard
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const companyWhere = (companyId) => (companyId ? { companyId } : {});

/**
 * → { verdict: "exact"|"close"|"none", several?: true, results: [{ productId, name, productCode, brand, company?, score, via[], matchedQuery, snippet? }], notes[] }
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
    const scope = companyId ? Prisma.sql`p."company_id" = ${companyId}` : Prisma.sql`true`;
    const key = keyOf(q);
    // exact code or exact full name always wins (case-, space- and Arabic-spelling-insensitive),
    // over the same products — same scope, no filters — the list tool shows
    const exact = await prisma.$queryRaw`
      SELECT p."id", (${KEY_SQL(Prisma.sql`lower(coalesce(p."product_code", ''))`)} = ${key}) AS "byCode"
      FROM "products" p
      WHERE ${scope} AND (${KEY_SQL(Prisma.sql`lower(coalesce(p."product_code", ''))`)} = ${key} OR ${KEY_SQL(NAME_SQL)} = ${key})`;
    for (const r of exact) add(r.id, 1, r.byCode ? "code" : "exact_name", q);

    const aliases = await prisma.productAlias.findMany({ where: { ...companyWhere(companyId), aliasNorm: normalizeName(q) }, select: { productId: true } });
    for (const a of aliases) add(a.productId, 0.95, "alias", q);

    const f = fold(q);
    const like = `%${likeEscape(f)}%`;
    const rows = await prisma.$queryRaw`
      SELECT p."id", ${NAME_SQL} AS "nm", greatest(similarity(${NAME_SQL}, ${f}), word_similarity(${f}, ${NAME_SQL})) AS "sim",
             (${NAME_SQL} LIKE ${like}) AS "contains"
      FROM "products" p
      WHERE ${scope}
        AND (${NAME_SQL} % ${f} OR ${f} <% ${NAME_SQL} OR ${NAME_SQL} LIKE ${like})
      ORDER BY 3 DESC
      LIMIT 20`;
    for (const r of rows) {
      const sim = Number(r.sim) || 0;
      const nm = String(r.nm || "").replace(/\s+/g, " ").trim();
      if (hits.get(r.id)?.via.has("exact_name") || hits.get(r.id)?.via.has("code")) continue;
      // the query as whole words of the name ("Vitaminol" in "Vitaminol 500") is strong; a similar spelling is not
      const words = ` ${nm} `.includes(` ${f} `);
      const score = words ? Math.max(0.9, 0.9 * sim) : r.contains ? Math.max(0.6, 0.85 * sim) : 0.85 * sim;
      if (score >= MIN_TRGM * 0.85) add(r.id, Math.round(score * 1000) / 1000, words ? "name_words" : "name", q);
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
  return { verdict: verdictOf(results), ...(severalExact(results) ? { several: true } : {}), results, notes };
}

const STRONG = ["code", "alias", "exact_name"];

/**
 * "exact": matched by its exact code, a saved alias or its exact full name (case-,
 * space- and Arabic-spelling-insensitive). Anything else that matched is "close": a
 * similar spelling (DOXYVET → MOXYVET) is never presented as the product asked for.
 * "none": nothing matched.
 */
export function verdictOf(results) {
  if (!results.length) return "none";
  return results[0].via.some((v) => STRONG.includes(v)) ? "exact" : "close";
}

/** Several products match exactly (the same name in two companies, a code printed twice): ask which. */
export const severalExact = (results) => results.filter((r) => r.via.some((v) => STRONG.includes(v))).length > 1;
