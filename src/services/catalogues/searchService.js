import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { CertError } from "../certificates/errors.js";

// Catalogue search (plan.md §15.6, A6.6): Postgres full text over every printed
// block plus pg_trgm on the product name, ALWAYS scoped to one company.
//  - The FTS and name expressions are the indexed ones (migration
//    20261023170000_catalogue_search) — keep them identical.
//  - 'simple' text config: no stemming and no stop words, so codes ("AKS0"),
//    doses and "None" are found as printed.
//  - A query of several words matches a block holding all of them; the blocks
//    holding them as a phrase ("Vitamin E") rank first and are marked `phrase`.
//    The last word is also a prefix when it has ≥ 3 characters ("AKS0" → AKS01…).
//  - Fuzzy product names: pg_trgm similarity ≥ 0.3 on the extracted name / title.
//  - By default only each catalogue's latest version is searched (older editions
//    repeat the same products); `allVersions` searches every edition.

const FTS = Prisma.sql`to_tsvector('simple', coalesce(b."title", '') || ' ' || b."text")`;
const NAME = Prisma.sql`lower(coalesce(b."extracted" #>> '{record,name}', b."title", ''))`;
const MIN_SIMILARITY = 0.3;
const SNIPPET = "StartSel=[[, StopSel=]], MaxWords=28, MinWords=12, ShortWord=1, MaxFragments=2, FragmentDelimiter= … ";

/** query text → the words the 'simple' parser would index (letters/digits runs, lower-cased) */
export const queryWords = (q) =>
  String(q || "")
    .toLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu) || [];

/** words → a safe to_tsquery string (every word quoted; the last one a prefix when long enough) */
function tsQuery(words, { prefixLast = true, op = "&" } = {}) {
  return words.map((w, i) => `'${w.replace(/'/g, "")}'${prefixLast && i === words.length - 1 && w.length >= 3 ? ":*" : ""}`).join(` ${op} `);
}

/**
 * GET /catalogue-search?q=&companyId=
 * → { q, results: [{ blockId, versionId, catalogueId, manufacturer, versionLabel, page, kind, name, productCode, productId, status, snippet, match: phrase|words|name, rank }] }
 */
export async function searchCatalogues(companyId, q, { limit = 30, allVersions = false } = {}) {
  if (!companyId) throw new CertError("COMPANY_REQUIRED", "Pick a company to search its catalogues", 400);
  const words = queryWords(q).slice(0, 12);
  if (!words.length) throw new CertError("QUERY_REQUIRED", "Type something to search", 400);
  const all = tsQuery(words);
  const phrase = words.length > 1 ? words.map((w) => `'${w}'`).join(" <-> ") : null;
  const latestOnly = allVersions
    ? Prisma.empty
    : Prisma.sql`AND v."id" = (SELECT v2."id" FROM "catalogue_versions" v2 WHERE v2."catalogue_id" = v."catalogue_id" AND v2."status" NOT IN ('failed', 'uploaded', 'segmenting') ORDER BY v2."created_at" DESC LIMIT 1)`;
  const text = words.join(" ");
  const rows = await prisma.$queryRaw`
    SELECT b."id" AS "blockId", b."version_id" AS "versionId", v."catalogue_id" AS "catalogueId", c."manufacturer", v."label" AS "versionLabel",
           b."page", b."kind", b."status", b."product_id" AS "productId", b."title",
           b."extracted" #>> '{record,name}' AS "name", coalesce(b."extracted" #>> '{manual,productCode,value}', b."extracted" #>> '{record,productCode}') AS "productCode",
           ${phrase ? Prisma.sql`(${FTS} @@ to_tsquery('simple', ${phrase}))` : Prisma.sql`false`} AS "isPhrase",
           (${FTS} @@ to_tsquery('simple', ${all})) AS "isWords",
           similarity(${NAME}, ${text}) AS "nameSim",
           ts_rank_cd(${FTS}, to_tsquery('simple', ${all})) AS "rank",
           ts_headline('simple', b."text", to_tsquery('simple', ${all}), ${SNIPPET}) AS "snippet"
    FROM "catalogue_blocks" b
    JOIN "catalogue_versions" v ON v."id" = b."version_id"
    JOIN "catalogues" c ON c."id" = v."catalogue_id"
    WHERE b."company_id" = ${companyId}
      AND b."status" <> 'rejected'
      ${latestOnly}
      AND (${FTS} @@ to_tsquery('simple', ${all}) OR ${NAME} % ${text})
    ORDER BY 1`;
  const results = rows
    .map((r) => {
      const nameSim = Number(r.nameSim) || 0;
      const match = r.isPhrase ? "phrase" : r.isWords ? "words" : nameSim >= MIN_SIMILARITY ? "name" : null;
      if (!match) return null;
      const score = (r.isPhrase ? 2 : 0) + (r.isWords ? 1 : 0) + Number(r.rank || 0) + nameSim;
      return {
        blockId: r.blockId,
        versionId: r.versionId,
        catalogueId: r.catalogueId,
        manufacturer: r.manufacturer,
        versionLabel: r.versionLabel,
        page: r.page,
        kind: r.kind,
        status: r.status,
        productId: r.productId,
        name: r.name || r.title || null,
        productCode: r.productCode || null,
        snippet: r.isWords ? r.snippet : null,
        match,
        nameSimilarity: Math.round(nameSim * 100) / 100,
        score: Math.round(score * 1000) / 1000,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .slice(0, Math.min(Math.max(1, limit), 100));
  return { q: String(q), words, results };
}

/**
 * Invoice matching (A3) — the catalogue as an extra candidate source: blocks of
 * the company's latest catalogue editions that are linked to a product and print
 * most words of the invoice line's name. → Map(productId → { score, reasons })
 * Candidates only: a catalogue hit never matches a line automatically.
 */
export async function catalogueCandidates(companyId, lineName) {
  const words = [...new Set(queryWords(lineName).filter((w) => w.length >= 2))].slice(0, 10);
  if (words.length < 2 || !companyId) return new Map();
  const any = tsQuery(words, { prefixLast: false, op: "|" });
  const rows = await prisma.$queryRaw`
    SELECT b."product_id" AS "productId", b."page", lower(coalesce(b."title", '') || ' ' || b."text") AS "body", coalesce(b."extracted" #>> '{record,name}', b."title") AS "name"
    FROM "catalogue_blocks" b
    JOIN "catalogue_versions" v ON v."id" = b."version_id"
    WHERE b."company_id" = ${companyId} AND b."product_id" IS NOT NULL AND b."kind" = 'product'
      AND v."id" = (SELECT v2."id" FROM "catalogue_versions" v2 WHERE v2."catalogue_id" = v."catalogue_id" AND v2."status" IN ('review', 'applied') ORDER BY v2."created_at" DESC LIMIT 1)
      AND ${FTS} @@ to_tsquery('simple', ${any})
    ORDER BY ts_rank_cd(${FTS}, to_tsquery('simple', ${any})) DESC
    LIMIT 10`;
  const out = new Map();
  for (const r of rows) {
    const printed = new Set(queryWords(r.body));
    const hit = words.filter((w) => printed.has(w));
    const share = hit.length / words.length;
    if (hit.length < 2 || share < 0.5) continue;
    const score = Math.round(0.8 * share * 1000) / 1000; // below an exact code/name match, never auto
    const prev = out.get(r.productId);
    if (!prev || prev.score < score) out.set(r.productId, { score, reasons: [`catalogue p.${r.page}: ${hit.length}/${words.length} words printed`] });
  }
  return out;
}
