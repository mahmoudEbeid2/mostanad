import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../../certificates/errors.js";
import * as fileStore from "../../certificates/storage/fileStore.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { priceAt, ratesFor, costUsd } from "../../ai/modelPrices.js";
import { readPdfLayout } from "../pdfLayout.js";
import { segment } from "../segmenter.js";
import { classifyPage, autoSelection, BLANK_CHARS } from "./pageKinds.js";
import { renderPages, pageImage } from "./pageImages.js";
import { normalisePages } from "./pdfSplit.js";

// "Choose catalogue pages" (C1). At upload code reads every page — kind, text
// length, thumbnail — and picks the default selection; nothing here calls the AI.
// A person keeps or skips pages; only the kept pages are split out of the PDF and
// read by the extraction (extractionService). Every query is tenant-scoped:
// another company's version is reported missing (404).

const visible = (row, companyScope) => !!row && (!companyScope || row.companyId === companyScope);

async function loadVersion(id, companyScope) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id }, include: { catalogue: { select: { id: true, manufacturer: true } } } });
  if (!visible(version, companyScope)) throw notFound("Catalogue version");
  return version;
}

/**
 * The selection a new version starts with: the saved selection of the latest
 * earlier version of the same catalogue (same company + manufacturer) that a
 * person saved or extracted, cut to this file's page range — else the auto one.
 */
async function startingSelection(version, pages) {
  const earlier = await prisma.catalogueVersion.findMany({
    where: { catalogueId: version.catalogueId, companyId: version.companyId, id: { not: version.id }, createdAt: { lte: version.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { id: true, pageSelection: true },
  });
  const prior = earlier.find((v) => v.pageSelection?.savedAt) || null;
  const count = pages.length;
  const reused = (prior?.pageSelection?.pages || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
  const at = new Date().toISOString();
  if (reused.length) return { pages: normalisePages(reused), source: "previous", fromVersionId: prior.id, at };
  return { pages: autoSelection(pages), source: "auto", at };
}

/**
 * Reads, classifies and draws every page of a version (the segment job, or on
 * demand for a version uploaded before C1). layout/blocks: when the caller has
 * them already. Writes the page rows and — unless a person already chose — the
 * starting selection. → { pages, selection }
 */
export async function analysePages(version, { buffer = null, layout = null, blocks = null, ctx = { progress: () => {} } } = {}) {
  const pdf = buffer || (await fileStore.readFile(version.sourceFileId, { companyId: version.companyId })).buffer;
  const lay = layout || (await readPdfLayout(pdf));
  const segs = blocks || segment(lay).blocks;
  const productsOn = new Map();
  for (const b of segs) if (b.kind === "product") productsOn.set(b.page, (productsOn.get(b.page) || 0) + 1);
  ctx.progress?.(70, "Drawing page thumbnails");
  const images = await renderPages(pdf, { companyId: version.companyId, versionId: version.id, size: "thumb" });
  const last = lay.pages.length;
  const pages = lay.pages.map((p) => {
    const c = classifyPage(p, { productBlocks: productsOn.get(p.n) || 0, last: p.n === last && last > 1, drawn: images.get(p.n)?.drawn ?? true });
    return { number: p.n, kind: c.kind, textLength: c.textLength, reason: c.reason, width: p.width, height: p.height };
  });
  const keep = version.pageSelection?.source === "user" ? null : await startingSelection(version, pages);
  await prisma.$transaction([
    prisma.cataloguePage.deleteMany({ where: { versionId: version.id } }),
    prisma.cataloguePage.createMany({ data: pages.map((p) => ({ ...p, versionId: version.id, companyId: version.companyId })) }),
    ...(keep ? [prisma.catalogueVersion.update({ where: { id: version.id }, data: { pageSelection: keep } })] : []),
  ]);
  return { pages, selection: keep || version.pageSelection };
}

/** The page rows of a version, analysed now when it has none yet (uploaded before C1). While the upload job still runs it owns them: none yet. */
async function pagesOf(version) {
  let rows = await prisma.cataloguePage.findMany({ where: { versionId: version.id }, orderBy: { number: "asc" } });
  if (!rows.length && !["uploaded", "segmenting"].includes(version.status)) {
    await analysePages(version);
    rows = await prisma.cataloguePage.findMany({ where: { versionId: version.id }, orderBy: { number: "asc" } });
  }
  return rows;
}

// ── estimate ──
// Per page with text, from the ledger's real catalogue calls (each tagged with
// the original pages it read); a constant only while there is no history. A
// page without text is never read (no block) and costs nothing.
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

const readable = (p) => p.textLength >= BLANK_CHARS;

/** page number → its share of the per-page average, by its text: a cover costs a tenth of a product page */
function pageWeights(pages) {
  const read = pages.filter(readable);
  const mean = read.reduce((s, p) => s + p.textLength, 0) / (read.length || 1);
  return new Map(pages.map((p) => [p.number, readable(p) ? p.textLength / mean : 0]));
}

/** pages: page rows · selected: page numbers → { selected, all, savedPercent, basis, … } */
export function estimate(pages, selected, rates) {
  const set = new Set(selected);
  const weights = pageWeights(pages);
  const of = (list) => {
    const n = list.reduce((s, p) => s + weights.get(p.number), 0);
    const t = { pages: list.filter(readable).length, input: Math.round(n * rates.input), output: Math.round(n * rates.output) };
    return { ...t, tokens: t.input + t.output, costUsd: costOf(rates, { ...t, pages: n }) };
  };
  const sel = of(pages.filter((p) => set.has(p.number)));
  const all = of(pages);
  return {
    selected: sel,
    all,
    savedPercent: all.tokens ? Math.round((100 * (all.tokens - sel.tokens)) / all.tokens) : 0,
    // so a screen can re-estimate while a person clicks pages (perPage × each page's `weight`)
    perPage: { input: Math.round(rates.input), output: Math.round(rates.output), costUsd: costOf(rates, { pages: 1, input: Math.round(rates.input), output: Math.round(rates.output) }) },
    basis: rates.basis, // "ledger" | "constant" — either way an estimate
    sample: { calls: rates.calls, pages: rates.pages },
    priced: sel.costUsd !== null,
    estimate: true,
  };
}

const imageUrl = (versionId, n, size) => `/catalogue-versions/${versionId}/pages/${n}/image${size === "large" ? "?size=large" : ""}`;

/** GET /catalogue-versions/:id/pages → { version, pageCount, pages, selection, estimate } */
export async function listPages(versionId, companyScope) {
  const version = await loadVersion(versionId, companyScope);
  const rows = await pagesOf(version);
  const fresh = version.pageSelection ? version : await prisma.catalogueVersion.findUnique({ where: { id: version.id } });
  const selection = fresh.pageSelection || { pages: autoSelection(rows), source: "auto" };
  const file = await fileStore.getFileRow(version.sourceFileId, { companyId: version.companyId }).catch(() => null);
  const weights = pageWeights(rows);
  return {
    version: { id: version.id, label: version.label, status: version.status, error: version.error, catalogue: version.catalogue, file: file ? { name: file.originalName, sizeBytes: file.sizeBytes } : null, extraction: version.extraction?.pages ? { pages: version.extraction.pages, at: version.extraction.at } : null },
    pageCount: rows.length,
    pages: rows.map((p) => ({ number: p.number, kind: p.kind, textLength: p.textLength, readable: readable(p), weight: Number(weights.get(p.number).toFixed(3)), reason: p.reason, width: p.width, height: p.height, thumbnailUrl: imageUrl(version.id, p.number, "thumb"), previewUrl: imageUrl(version.id, p.number, "large") })),
    selection,
    estimate: estimate(rows, selection.pages, await perPageRates()),
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
  if (["segmenting", "extracting"].includes(version.status)) throw new CertError("VERSION_BUSY", `The catalogue is ${version.status === "segmenting" ? "still being read" : "being extracted"} — choose pages when it is done`, 409);
  const rows = await pagesOf(version);
  const list = assertSelection(pages, rows.length);
  const now = new Date().toISOString();
  const selection = { pages: list, source: "user", savedByUserId: userId, at: now, savedAt: now };
  await prisma.catalogueVersion.update({ where: { id: version.id }, data: { pageSelection: selection } });
  return { selection, estimate: estimate(rows, list, await perPageRates()) };
}

/** The selection the extraction reads (the saved one, else the auto one). → { pages, pageCount, selection } */
export async function selectionForExtraction(version) {
  const rows = await pagesOf(version);
  const fresh = await prisma.catalogueVersion.findUnique({ where: { id: version.id }, select: { pageSelection: true } });
  const selection = fresh.pageSelection || { pages: autoSelection(rows), source: "auto", at: new Date().toISOString() };
  const pages = assertSelection(selection.pages, rows.length);
  return { pages, pageCount: rows.length, selection };
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
