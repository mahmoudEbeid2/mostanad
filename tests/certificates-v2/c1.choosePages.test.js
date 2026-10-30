// C1 — choose the catalogue pages sent to the AI.
// Proven here:
//  - the split PDF holds exactly the selected pages, in the original order
//  - page kinds by code on a fixture catalogue: cover, contents, blank, about, contact,
//    back skipped; product pages kept; a scanned page (no text) is "unknown" and kept
//  - extraction reads only the kept pages; every block keeps its ORIGINAL page number
//    (also on the product an accepted block creates); each AI call is tagged with the
//    catalogue and its pages; calls group whole pages
//  - selection: out of range / empty refused; the next version reuses the saved one
//  - tenancy: another company gets 404 on every new endpoint
//  - upload + page detection make no AI call (GEMINI_DISABLED stack: no ledger row, no run, no extract task)
// Needs the guarded stack (npm run dev:test).
import fs from "fs";
import path from "path";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma } from "./helpers.js";
import { fixtureCatalogue } from "./c1Fixture.js";
import { splitPdf } from "../../src/services/catalogues/pages/pdfSplit.js";
import { readPdfLayout } from "../../src/services/catalogues/pdfLayout.js";
import { segment } from "../../src/services/catalogues/segmenter.js";
import { classifyPage, autoSelection } from "../../src/services/catalogues/pages/pageKinds.js";
import { runExtractJob, pageGroups } from "../../src/services/catalogues/extraction/extractionService.js";
import { currentAiContext } from "../../src/services/ai/aiContext.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const co = await createCompany("c1a");
const coB = await createCompany("c1b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

async function upload(buffer, { manufacturer = "Agrikima Sdn. Bhd.", catalogueId = null, label } = {}) {
  const r = catalogueId
    ? await api("POST", `/catalogues/${catalogueId}/versions`, asAdmin, form({ label }, { buffer, name: "c.pdf", type: "application/pdf" }))
    : await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer, label }, { buffer, name: "c.pdf", type: "application/pdf" }));
  const task = await pollTask(r.data.data.jobId, asAdmin, { timeoutMs: 120_000 });
  return { ...r.data.data, task };
}

/** A stand-in model: records what it was sent and what the ledger context was, answers every block with its name only. */
const standIn = (calls) => async (args) => {
  const payload = JSON.parse(args.contents[1].slice("Blocks:\n".length));
  calls.push({ payload, ctx: currentAiContext() });
  return { products: payload.blocks.map((b) => ({ blockId: b.blockId, isProduct: true, name: { value: b.text.split("\n")[0].split("\t")[0], quote: b.text.split("\n")[0].split("\t")[0] } })) };
};

try {
  console.log("\n✂️ The split PDF holds exactly the selected pages, in the original order");
  const fx = await fixtureCatalogue();
  const fxLayout = await readPdfLayout(fx);
  const s1 = await splitPdf(fx, [6, 2, 9, 2, 4]);
  const l1 = await readPdfLayout(s1.buffer);
  const firstLine = (p) => p.items[0]?.s || "";
  assert("pages sorted and de-duplicated: 2, 4, 6, 9", JSON.stringify(s1.pageMap) === "[2,4,6,9]", s1.pageMap);
  assert("the split file has 4 pages, each the original one", l1.pages.length === 4 && l1.pages.every((p, i) => firstLine(p) === firstLine(fxLayout.pages[s1.pageMap[i] - 1])), l1.pages.map(firstLine));
  const s2 = await splitPdf(pdf, [4, 9, 15]);
  const l2 = await readPdfLayout(s2.buffer);
  const full = await readPdfLayout(pdf);
  const textOf = (p) => p.items.map((i) => i.s).join(" ");
  assert("Agrikima split to p.4, 9, 15: same text as those pages", l2.pages.length === 3 && [4, 9, 15].every((n, i) => textOf(l2.pages[i]) === textOf(full.pages[n - 1])));
  let threw = false;
  try { await splitPdf(pdf, [0, 19]); } catch (e) { threw = e instanceof RangeError; }
  assert("a page outside the file → refused", threw);

  console.log("\n🔎 Page kinds by code (fixture catalogue)");
  const seg = segment(fxLayout);
  const on = new Map();
  for (const b of seg.blocks) if (b.kind === "product") on.set(b.page, (on.get(b.page) || 0) + 1);
  const drawnOf = { 3: false, 8: true };
  const kinds = fxLayout.pages.map((p) => ({ number: p.n, ...classifyPage(p, { productBlocks: on.get(p.n) || 0, last: p.n === 9, drawn: drawnOf[p.n] ?? true }) }));
  const k = Object.fromEntries(kinds.map((p) => [p.number, p.kind]));
  assert("1 cover · 2 contents · 3 blank · 4 product · 5 about · 6 product · 7 contact · 8 unknown · 9 back", JSON.stringify(k) === JSON.stringify({ 1: "cover", 2: "contents", 3: "blank", 4: "product", 5: "about", 6: "product", 7: "contact", 8: "unknown", 9: "back" }), k);
  assert("default selection = product pages + the scanned page: 4, 6, 8", JSON.stringify(autoSelection(kinds)) === "[4,6,8]", autoSelection(kinds));
  assert("the scanned page says it can't be auto-detected", /can't auto-detect/.test(kinds[7].reason));

  console.log("\n📤 Upload: pages read, no AI");
  const aiBefore = { calls: await prisma.aiCall.count({ where: { companyId: co.id } }), runs: await prisma.aiRun.count({ where: { companyId: co.id } }) };
  const up = await upload(fx, { manufacturer: "ACME Feed" });
  assert("the upload job completes without queueing an extraction", up.task.status === "completed" && !up.task.result.extractJobId, up.task);
  const extractTasks = await prisma.backgroundTask.count({ where: { companyId: co.id, type: "catalogue_extract" } });
  assert("…no catalogue_extract task exists", extractTasks === 0, extractTasks);
  assert("…no AI ledger row and no ai_run for the company", (await prisma.aiCall.count({ where: { companyId: co.id } })) === aiBefore.calls && (await prisma.aiRun.count({ where: { companyId: co.id } })) === aiBefore.runs);
  let r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, A);
  assert("GET …/pages (own company) → 200, 9 pages", r.status === 200 && r.data.data.pageCount === 9, r.data);
  const pagesApi = r.data.data;
  assert("kinds from the job: blank page 3 (nothing drawn), unknown page 8 (drawn, no text)", pagesApi.pages[2].kind === "blank" && pagesApi.pages[7].kind === "unknown", pagesApi.pages.map((p) => p.kind));
  assert("starting selection = 4, 6, 8 (auto)", JSON.stringify(pagesApi.selection.pages) === "[4,6,8]" && pagesApi.selection.source === "auto", pagesApi.selection);
  assert("estimate: labelled, fewer tokens for the selection than for all pages", pagesApi.estimate.estimate === true && ["ledger", "constant"].includes(pagesApi.estimate.basis) && pagesApi.estimate.selected.tokens < pagesApi.estimate.all.tokens && pagesApi.estimate.savedPercent > 0, pagesApi.estimate);
  r = await api("GET", pagesApi.pages[0].thumbnailUrl, A);
  assert("thumbnail → image/webp", r.status === 200 && /image\/webp/.test(r.headers.get("content-type")) && r.buffer?.length > 100 && r.buffer.subarray(8, 12).toString() === "WEBP");
  r = await api("GET", pagesApi.pages[3].previewUrl, A);
  assert("large preview → image/webp", r.status === 200 && r.buffer.subarray(8, 12).toString() === "WEBP");
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages/10/image`, A);
  assert("a page past the end → 404", r.status === 404);

  await prisma.cataloguePage.deleteMany({ where: { versionId: up.versionId } });
  await prisma.catalogueVersion.update({ where: { id: up.versionId }, data: { status: "segmenting" } });
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, A);
  assert("while the upload job runs: no pages yet, and GET doesn't analyse them itself", r.status === 200 && r.data.data.pageCount === 0 && (await prisma.cataloguePage.count({ where: { versionId: up.versionId } })) === 0, r.data);
  await prisma.catalogueVersion.update({ where: { id: up.versionId }, data: { status: "segmented" } });
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, A);
  assert("a segmented version without page rows (uploaded before C1) is analysed on demand", r.status === 200 && r.data.data.pageCount === 9, r.data);

  console.log("\n🧮 Selection rules");
  const PUT = (body, h = asAdmin, id = up.versionId) => api("PUT", `/catalogue-versions/${id}/page-selection`, h, body);
  r = await PUT({ pages: [] });
  assert("empty → 400 EMPTY_SELECTION", r.status === 400 && r.data.code === "EMPTY_SELECTION", r.data);
  r = await PUT({ pages: [0, 4] });
  assert("page 0 → 400 PAGE_OUT_OF_RANGE", r.status === 400 && r.data.code === "PAGE_OUT_OF_RANGE" && r.data.pageCount === 9, r.data);
  r = await PUT({ pages: [4, 10] });
  assert("page 10 of 9 → 400 PAGE_OUT_OF_RANGE", r.status === 400 && r.data.code === "PAGE_OUT_OF_RANGE" && r.data.invalid.includes(10), r.data);
  r = await PUT({ pages: [4.5] });
  assert("a non-integer → 400", r.status === 400);
  r = await PUT({ pages: [6, 4, 6] });
  assert("[6, 4, 6] → saved as [4, 6], source user", r.status === 200 && JSON.stringify(r.data.data.selection.pages) === "[4,6]" && r.data.data.selection.source === "user", r.data);
  assert("the stored selection was not changed by the refused ones", JSON.stringify((await prisma.catalogueVersion.findUnique({ where: { id: up.versionId } })).pageSelection.pages) === "[4,6]");

  console.log("\n🔒 Tenancy on every new endpoint");
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, B);
  assert("another company: GET …/pages → 404", r.status === 404, r.status);
  r = await api("GET", pagesApi.pages[0].thumbnailUrl, B);
  assert("another company: page image → 404", r.status === 404, r.status);
  r = await PUT({ pages: [1] }, B);
  assert("another company: PUT …/page-selection refused (403/404)", [403, 404].includes(r.status), r.status);
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages?companyId=${coB.id}`, asAdmin);
  assert("system user scoped to another company (?companyId=) → 404", r.status === 404, r.status);
  r = await api("PUT", `/catalogue-versions/${up.versionId}/page-selection?companyId=${coB.id}`, asAdmin, { pages: [1] });
  assert("system user, PUT with another ?companyId= → 404, selection untouched", r.status === 404 && JSON.stringify((await prisma.catalogueVersion.findUnique({ where: { id: up.versionId } })).pageSelection.pages) === "[4,6]", r.status);
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages/1/image?companyId=${coB.id}`, asAdmin);
  assert("system user, image with another ?companyId= → 404", r.status === 404, r.status);
  r = await api("POST", `/catalogue-versions/${up.versionId}/extract?companyId=${coB.id}`, asAdmin, {});
  assert("system user, extract with another ?companyId= → 404", r.status === 404, r.status);

  console.log("\n📄 Extraction reads only the kept pages; evidence keeps the original page");
  const ag = await upload(pdf, { label: "2022" });
  const agPages = (await api("GET", `/catalogue-versions/${ag.versionId}/pages`, A)).data.data;
  assert("Agrikima starts from its product pages 3–17 (auto)", JSON.stringify(agPages.selection.pages) === JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]));
  // cover, about and back hold about 4% of the text, not 3 of 18 pages' worth (17%)
  assert("the estimate weighs pages by their text: skipping them saves under 10%", agPages.estimate.savedPercent > 0 && agPages.estimate.savedPercent < 10, agPages.estimate.savedPercent);
  assert("a cover weighs far less than a product page", agPages.pages[0].weight < 0.2 && agPages.pages[3].weight > 1, agPages.pages.map((p) => p.weight));
  r = await PUT({ pages: [15, 4, 9] }, asAdmin, ag.versionId);
  assert("keep p.4, 9, 15 → 200", r.status === 200, r.data);
  const calls = [];
  const res = await runExtractJob(ag.versionId, undefined, { generate: standIn(calls), infer: false });
  const sentPages = [...new Set(calls.flatMap((c) => [...c.payload.blocks, ...(c.payload.contextBlocks || [])].map((b) => b.page)))].sort((a, b) => a - b);
  assert("only blocks of p.4, 9, 15 were sent, under their original numbers", JSON.stringify(sentPages) === "[4,9,15]", sentPages);
  assert("6 product blocks read (2 per page), in one call (whole pages, ≤ 6 blocks)", res.products === 6 && calls.length === 1, { products: res.products, calls: calls.length });
  assert("the call's ledger context: parent = the catalogue, meta.pages = [4, 9, 15]", calls[0].ctx.parentType === "catalogue" && calls[0].ctx.parentId === ag.catalogueId && JSON.stringify(calls[0].ctx.meta?.pages) === "[4,9,15]" && calls[0].ctx.meta.catalogueId === ag.catalogueId, calls[0].ctx);
  const v = await prisma.catalogueVersion.findUnique({ where: { id: ag.versionId } });
  assert("version.extraction: pages [4, 9, 15] of 18, split file of 3 pages", JSON.stringify(v.extraction.pages) === "[4,9,15]" && v.extraction.pageCount === 18 && v.extraction.split.pages === 3, v.extraction);
  const extracted = await prisma.catalogueBlock.findMany({ where: { versionId: ag.versionId, extracted: { not: null } } });
  assert("every extracted block is on p.4, 9 or 15", extracted.length === 6 && extracted.every((b) => [4, 9, 15].includes(b.page)), extracted.map((b) => b.page));
  r = await api("GET", `/catalogue-versions/${ag.versionId}/review`, asAdmin);
  assert("the review lists only the read pages' products", r.status === 200 && r.data.data.counts.products === 6 && r.data.data.blocks.every((b) => [4, 9, 15].includes(b.page)), r.data.data?.counts);
  const onP9 = extracted.find((b) => b.page === 9);
  r = await api("POST", `/catalogue-blocks/${onP9.id}/accept`, asAdmin);
  const product = r.data?.data?.productId ? await prisma.product.findUnique({ where: { id: r.data.data.productId } }) : null;
  assert("an accepted block's product cites its original page (catalogueRef.page = 9, provenance page 9)", product?.catalogueRef?.page === 9 && Object.values(product.fieldProvenance || {}).filter((p) => p.page !== undefined).every((p) => p.page === 9), { status: r.status, ref: product?.catalogueRef });
  assert("pageGroups: whole pages, at most 6 blocks", JSON.stringify(pageGroups([1, 1, 2, 2, 3, 3, 4, 4].map((page, i) => ({ id: i, page })), 6).map((g) => g.map((b) => b.page))) === "[[1,1,2,2,3,3],[4,4]]");

  console.log("\n🔁 The next version starts from the saved selection");
  const v2 = await upload(pdf, { catalogueId: ag.catalogueId, label: "2023" });
  r = await api("GET", `/catalogue-versions/${v2.versionId}/pages`, A);
  assert("v2 selection = [4, 9, 15], source previous, from v1", JSON.stringify(r.data.data.selection.pages) === "[4,9,15]" && r.data.data.selection.source === "previous" && r.data.data.selection.fromVersionId === ag.versionId, r.data.data.selection);
  const other = await upload(pdf, { manufacturer: "Another maker" });
  r = await api("GET", `/catalogue-versions/${other.versionId}/pages`, A);
  assert("another catalogue of the same company starts from auto", r.data.data.selection.source === "auto" && r.data.data.selection.pages.length === 15, r.data.data.selection);
} finally {
  await cleanupCompany(co.id);
  await cleanupCompany(coB.id);
}

await finish(counts);
