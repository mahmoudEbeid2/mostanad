import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../../certificates/errors.js";
import * as fileStore from "../../certificates/storage/fileStore.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { priceAt, ratesFor, costUsd } from "../../ai/modelPrices.js";
import { pageImage } from "./pageImages.js";
import { openPdf } from "./pdfInfo.js";
import { normalisePages } from "./pdfSplit.js";

// "Choose catalogue pages" (C1). The upload only opened the file: page rows with
// their sizes, nothing read and nothing selected. A person chooses the pages, and
// only those are split out of the PDF, read and sent to the AI (extractionService).
// Page images are drawn one at a time when first asked for. Every query is
// tenant-scoped: another company's version is reported missing (404).

const visible = (row, companyScope) => !!row && (!companyScope || row.companyId === companyScope);
const NO_SELECTION = { pages: [], source: "none" };

async function loadVersion(id, companyScope) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id }, include: { catalogue: { select: { id: true, manufacturer: true } } } });
  if (!visible(version, companyScope)) throw notFound("Catalogue version");
  return version;
}

/** The page rows of a version; one uploaded before the rows existed gets them now, from its file. */
async function pagesOf(version) {
  const rows = await prisma.cataloguePage.findMany({ where: { versionId: version.id }, orderBy: { number: "asc" } });
  if (rows.length) return rows;
  const { buffer } = await fileStore.readFile(version.sourceFileId, { companyId: version.companyId });
  const { pages } = await openPdf(buffer);
  await prisma.cataloguePage.createMany({ data: pages.map((p) => ({ ...p, versionId: version.id, companyId: version.companyId })), skipDuplicates: true });
  return prisma.cataloguePage.findMany({ where: { versionId: version.id }, orderBy: { number: "asc" } });
}

/**
 * What the latest earlier version of the same catalogue kept, cut to this file's
 * pages — an offer ("Same pages as last version"), never applied by itself.
 */
async function previousSelection(version, pageCount) {
  const earlier = await prisma.catalogueVersion.findMany({
    where: { catalogueId: version.catalogueId, companyId: version.companyId, id: { not: version.id }, createdAt: { lte: version.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, pageSelection: true },
  });
  const prior = earlier.find((v) => v.pageSelection?.savedAt && v.pageSelection.pages?.length);
  const pages = (prior?.pageSelection.pages || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount);
  return pages.length ? { pages: normalisePages(pages), fromVersionId: prior.id, label: prior.label } : null;
}

// ── estimate ──
// Per chosen page, from the ledger's real catalogue calls (each tagged with the
// original pages it read); a constant only while there is no history.
const FALLBACK_PER_PAGE = { input: 1200, output: 1400 };
const FEATURES = ["catalogue.extract", "catalogue.infer"];

export async function perPageRates() {
  // per feature: an extraction reads each page in one extract call, then all of them again in one infer call
  const rows = await prisma.$queryRaw`
    SELECT feature,
           count(*)::int AS calls,
           coalesce(sum(input_tokens), 0)::float AS input,
           coalesce(sum(output_tokens + thinking_tokens), 0)::float AS output,
           sum(cost_usd)::float AS cost,
           count(cost_usd)::int AS priced,
           coalesce(sum(jsonb_array_length(meta->'pages')), 0)::float AS pages
    FROM ai_calls
    WHERE feature = ANY(${FEATURES}) AND outcome = 'ok' AND jsonb_typeof(meta->'pages') = 'array'
    GROUP BY feature`;
  const extract = rows.find((r) => r.feature === "catalogue.extract");
  if (!extract?.calls || !extract.pages) return { basis: "constant", calls: 0, pages: 0, input: FALLBACK_PER_PAGE.input, output: FALLBACK_PER_PAGE.output, costPerPage: null };
  const used = rows.filter((r) => r.pages > 0);
  const per = (k) => used.reduce((s, r) => s + r[k] / r.pages, 0);
  const allPriced = used.every((r) => r.priced === r.calls && r.cost !== null);
  return {
    basis: "ledger",
    calls: used.reduce((s, r) => s + r.calls, 0),
    pages: extract.pages,
    input: per("input"),
    output: per("output"),
    // only when every call in the sample was priced; otherwise priced from the current table
    costPerPage: allPriced ? per("cost") : null,
  };
}

function costOf(rates, tokens) {
  if (rates.costPerPage !== null) return rates.costPerPage * tokens.pages;
  const price = ratesFor(priceAt(MODELS.CATALOGUE_EXTRACT.id, new Date()), tokens.input);
  return price ? costUsd({ inputTokens: tokens.input, outputTokens: tokens.output }, price) : null;
}

/** pageCount · selected: page numbers → { selected, all, savedPercent, perPage, basis, … } */
export function estimate(pageCount, selected, rates) {
  const of = (n) => {
    const t = { pages: n, input: Math.round(n * rates.input), output: Math.round(n * rates.output) };
    return { ...t, tokens: t.input + t.output, costUsd: costOf(rates, t) };
  };
  const sel = of(new Set(selected).size);
  const all = of(pageCount);
  return {
    selected: sel,
    all,
    savedPercent: all.tokens ? Math.round((100 * (all.tokens - sel.tokens)) / all.tokens) : 0,
    // so a screen can re-estimate while a person clicks pages
    perPage: { input: Math.round(rates.input), output: Math.round(rates.output), costUsd: costOf(rates, { pages: 1, input: Math.round(rates.input), output: Math.round(rates.output) }) },
    basis: rates.basis, // "ledger" | "constant" — either way an estimate
    sample: { calls: rates.calls, pages: rates.pages },
    priced: sel.costUsd !== null,
    estimate: true,
  };
}

const imageUrl = (versionId, n, size) => `/catalogue-versions/${versionId}/pages/${n}/image${size === "large" ? "?size=large" : ""}`;

/** GET /catalogue-versions/:id/pages → { version, pageCount, pages, selection, previousSelection, reviewedPages, estimate } */
export async function listPages(versionId, companyScope) {
  const version = await loadVersion(versionId, companyScope);
  const rows = await pagesOf(version);
  const selection = version.pageSelection || NO_SELECTION;
  const file = await fileStore.getFileRow(version.sourceFileId, { companyId: version.companyId }).catch(() => null);
  // pages whose products a person already reviewed or linked: taking the page out keeps those
  const decided = await prisma.catalogueBlock.findMany({ where: { versionId, OR: [{ status: { not: "pending" } }, { productId: { not: null } }] }, select: { page: true }, distinct: ["page"] });
  return {
    version: { id: version.id, label: version.label, status: version.status, error: version.error, catalogue: version.catalogue, file: file ? { name: file.originalName, sizeBytes: file.sizeBytes } : null, extraction: version.extraction?.pages ? { pages: version.extraction.pages, at: version.extraction.at } : null },
    pageCount: rows.length,
    pages: rows.map((p) => ({ number: p.number, width: p.width, height: p.height, thumbnailUrl: imageUrl(version.id, p.number, "thumb"), previewUrl: imageUrl(version.id, p.number, "large") })),
    selection,
    previousSelection: await previousSelection(version, rows.length),
    reviewedPages: decided.map((b) => b.page).sort((a, b) => a - b),
    estimate: estimate(rows.length, selection.pages, await perPageRates()),
  };
}

/** Validates a page list against a version's page count. → normalised pages */
export function assertSelection(pages, pageCount) {
  if (!Array.isArray(pages) || !pages.length) throw new CertError("EMPTY_SELECTION", "Keep at least one page", 400);
  const bad = pages.filter((n) => !Number.isInteger(n) || n < 1 || n > pageCount);
  if (bad.length) throw new CertError("PAGE_OUT_OF_RANGE", `Pages must be between 1 and ${pageCount} — ${bad.slice(0, 5).join(", ")} ${bad.length > 1 ? "are" : "is"} not`, 400, { pageCount, invalid: bad.slice(0, 20) });
  return normalisePages(pages);
}

/** PUT /catalogue-versions/:id/page-selection { pages } → { selection, estimate } */
export async function saveSelection(versionId, companyScope, pages, userId = null) {
  const version = await loadVersion(versionId, companyScope);
  if (version.status === "extracting") throw new CertError("VERSION_BUSY", "The catalogue is being extracted — choose pages when it is done", 409);
  const rows = await pagesOf(version);
  const list = assertSelection(pages, rows.length);
  const now = new Date().toISOString();
  const selection = { pages: list, source: "user", savedByUserId: userId, at: now, savedAt: now };
  await prisma.catalogueVersion.update({ where: { id: version.id }, data: { pageSelection: selection } });
  return { selection, estimate: estimate(rows.length, list, await perPageRates()) };
}

/** The saved selection the extraction reads; nothing chosen is refused. → { pages, pageCount, selection } */
export async function selectionForExtraction(version) {
  const rows = await pagesOf(version);
  const fresh = await prisma.catalogueVersion.findUnique({ where: { id: version.id }, select: { pageSelection: true } });
  const selection = fresh.pageSelection || NO_SELECTION;
  return { pages: assertSelection(selection.pages, rows.length), pageCount: rows.length, selection };
}

/** GET /catalogue-versions/:id/pages/:n/image?size= → file path of the WebP */
export async function pageImageFile(versionId, companyScope, n, size = "thumb") {
  const version = await loadVersion(versionId, companyScope);
  const count = version.pages || (await prisma.cataloguePage.count({ where: { versionId } }));
  if (!Number.isInteger(n) || n < 1 || (count && n > count)) throw notFound("Catalogue page");
  const file = await pageImage(async () => (await fileStore.readFile(version.sourceFileId, { companyId: version.companyId })).buffer, { companyId: version.companyId, versionId: version.id, n, size });
  if (!file) throw notFound("Catalogue page");
  return file;
}
