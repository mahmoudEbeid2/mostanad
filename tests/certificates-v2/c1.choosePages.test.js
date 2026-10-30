// C0/C1 — a catalogue upload is fast, and a PERSON chooses the pages.
// Proven here:
//  - an upload opens the file once: no text read, nothing segmented, no page drawn (spies on
//    pdf.js), nothing queued, no AI; bad files refused before anything is stored or queued
//  - GET pages: sizes and image urls, no kinds, nothing selected; the previous version's
//    selection is offered, cut to this file, and not applied
//  - one image request renders one page, once; cached after that
//  - selection: out of range / empty refused; Extract with nothing chosen refused
//  - extraction reads and segments ONLY the chosen pages; blocks keep their ORIGINAL numbers
//    (also on the product an accepted block creates); each AI call tagged with catalogue + pages
//  - changing the selection afterwards: only new pages are read and extracted; unreviewed blocks
//    of removed pages are dropped, reviewed ones stay
//  - task progress (progress, message, stage, stages) is on the row and in GET /background-tasks/:id
//  - versions saved with an old automatic selection keep working
//  - tenancy: another company gets 404 on every endpoint
// Needs the guarded stack (npm run dev:test:light).
import fs from "fs";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma } from "./helpers.js";
import { fixtureCatalogue, encryptedPdf } from "./c1Fixture.js";
import { splitPdf } from "../../src/services/catalogues/pages/pdfSplit.js";
import { readPdfLayout } from "../../src/services/catalogues/pdfLayout.js";
import { uploadCatalogue } from "../../src/services/catalogues/catalogueService.js";
import { pageImageFile, estimate } from "../../src/services/catalogues/pages/pageService.js";
import { cachePath } from "../../src/services/catalogues/pages/pageImages.js";
import { runExtractJob, pageGroups } from "../../src/services/catalogues/extraction/extractionService.js";
import { currentAiContext } from "../../src/services/ai/aiContext.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const co = await createCompany("c1a");
const coB = await createCompany("c1b");
const A = asCompany(co.id);
const B = asCompany(coB.id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// spies on pdf.js itself: every text read and every page drawn in this process is counted
const probe = await getDocument({ data: new Uint8Array(await fixtureCatalogue()) }).promise;
const proto = Object.getPrototypeOf(await probe.getPage(1));
await probe.destroy();
const spy = { text: 0, render: 0 };
const { getTextContent, render } = proto;
proto.getTextContent = function (...a) {
  spy.text++;
  return getTextContent.apply(this, a);
};
proto.render = function (...a) {
  spy.render++;
  return render.apply(this, a);
};
const resetSpy = () => Object.assign(spy, { text: 0, render: 0 });

async function upload(buffer, { manufacturer = "Agrikima Sdn. Bhd.", catalogueId = null, label } = {}) {
  const r = catalogueId
    ? await api("POST", `/catalogues/${catalogueId}/versions`, asAdmin, form({ label }, { buffer, name: "c.pdf", type: "application/pdf" }))
    : await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer, label }, { buffer, name: "c.pdf", type: "application/pdf" }));
  return { ...r.data.data, status: r.status, body: r.data };
}

/** A stand-in model: records what it was sent and what the ledger context was, answers every block with its name only. */
const standIn = (calls) => async (args) => {
  const payload = JSON.parse(args.contents[1].slice("Blocks:\n".length));
  calls.push({ payload, ctx: currentAiContext() });
  return { products: payload.blocks.map((b) => ({ blockId: b.blockId, isProduct: true, name: { value: b.text.split("\n")[0].split("\t")[0], quote: b.text.split("\n")[0].split("\t")[0] } })) };
};

try {
  const fx = await fixtureCatalogue();
  const counted = async () => ({ catalogues: await prisma.catalogue.count({ where: { companyId: co.id } }), versions: await prisma.catalogueVersion.count({ where: { companyId: co.id } }), files: await prisma.storedFile.count({ where: { companyId: co.id } }), tasks: await prisma.backgroundTask.count({ where: { companyId: co.id } }) });

  console.log("\n🚫 Bad files are refused before anything is stored or queued");
  const clean = await counted();
  let r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id }, { buffer: Buffer.from("not a pdf"), name: "x.pdf" }));
  assert("not a PDF → 415 NOT_A_PDF", r.status === 415 && r.data.code === "NOT_A_PDF", r.data);
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id }, { buffer: Buffer.from("%PDF-1.7\nthis is no pdf at all, only its first line"), name: "x.pdf" }));
  assert("a corrupt PDF → 422 PDF_UNREADABLE with a clear message", r.status === 422 && r.data.code === "PDF_UNREADABLE" && /can't be opened/.test(r.data.message), r.data);
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id }, { buffer: encryptedPdf("secret"), name: "x.pdf" }));
  assert("a password-protected PDF → 422, says so", r.status === 422 && r.data.code === "PDF_PASSWORD_PROTECTED" && /password-protected/.test(r.data.message), r.data);
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id }, { buffer: encryptedPdf(""), name: "x.pdf" }));
  assert("locked by an owner password only (it opens, but can't be split) → 422 too", r.status === 422 && r.data.code === "PDF_PASSWORD_PROTECTED", r.data);
  assert("nothing was stored or queued for any of them", same(await counted(), clean), await counted());

  console.log("\n✂️ The split PDF holds exactly the selected pages, in the original order");
  const fxLayout = await readPdfLayout(fx);
  const s1 = await splitPdf(fx, [6, 2, 9, 2, 4]);
  const l1 = await readPdfLayout(s1.buffer);
  const firstLine = (p) => p.items[0]?.s || "";
  assert("pages sorted and de-duplicated: 2, 4, 6, 9", same(s1.pageMap, [2, 4, 6, 9]), s1.pageMap);
  assert("the split file has 4 pages, each the original one", l1.pages.length === 4 && l1.pages.every((p, i) => firstLine(p) === firstLine(fxLayout.pages[s1.pageMap[i] - 1])), l1.pages.map(firstLine));
  let threw = false;
  try {
    await splitPdf(pdf, [0, 19]);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert("a page outside the file → refused", threw);

  console.log("\n📤 Upload: opens the file, nothing else");
  resetSpy();
  const direct = await uploadCatalogue({ companyId: co.id, manufacturer: "Direct", label: "spied", file: { buffer: pdf, originalname: "a.pdf" } });
  assert("spies: 18 pages, no text read, no page drawn", direct.pageCount === 18 && spy.text === 0 && spy.render === 0, spy);
  const aiBefore = { calls: await prisma.aiCall.count({ where: { companyId: co.id } }), runs: await prisma.aiRun.count({ where: { companyId: co.id } }) };
  const up = await upload(fx, { manufacturer: "ACME Feed" });
  assert("POST → 201: pages_ready, 9 pages, no job", up.status === 201 && up.status === 201 && up.pageCount === 9 && !up.jobId, up.body);
  const uv = await prisma.catalogueVersion.findUnique({ where: { id: up.versionId } });
  assert("the version is pages_ready with 9 pages", uv.status === "pages_ready" && uv.pages === 9, uv);
  const rows = await prisma.cataloguePage.findMany({ where: { versionId: up.versionId }, orderBy: { number: "asc" } });
  assert("9 page rows with their sizes, no kind, no text length", rows.length === 9 && rows.every((p, i) => p.number === i + 1 && p.width === 595 && p.height === 842 && p.kind === null && p.textLength === 0));
  assert("no block read", (await prisma.catalogueBlock.count({ where: { versionId: up.versionId } })) === 0);
  assert("no page drawn", !fs.existsSync(path.dirname(cachePath(co.id, up.versionId, 1))));
  assert("nothing queued: no task for the company", (await prisma.backgroundTask.count({ where: { companyId: co.id } })) === clean.tasks);
  assert("no AI ledger row and no ai_run", (await prisma.aiCall.count({ where: { companyId: co.id } })) === aiBefore.calls && (await prisma.aiRun.count({ where: { companyId: co.id } })) === aiBefore.runs);

  console.log("\n📄 GET pages");
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, A);
  const pagesApi = r.data.data;
  assert("own company → 200, 9 pages", r.status === 200 && pagesApi.pageCount === 9, r.data);
  assert("number, size and image urls; no kind, no reason", same(Object.keys(pagesApi.pages[0]).sort(), ["height", "number", "previewUrl", "thumbnailUrl", "width"]), pagesApi.pages[0]);
  assert("nothing selected, nothing offered", pagesApi.selection.pages.length === 0 && pagesApi.previousSelection === null, pagesApi.selection);
  assert("estimate labelled: 0 for the selection, a number for all pages", pagesApi.estimate.estimate === true && ["ledger", "constant"].includes(pagesApi.estimate.basis) && pagesApi.estimate.selected.tokens === 0 && pagesApi.estimate.all.tokens > 0 && pagesApi.estimate.all.pages === 9, pagesApi.estimate);
  const e = estimate(100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { basis: "constant", calls: 0, pages: 0, input: 100, output: 200, costPerPage: null });
  assert("10 of 100 pages: a tenth of the tokens, 90% saved", e.selected.tokens === 3000 && e.all.tokens === 30000 && e.savedPercent === 90, e);

  console.log("\n🖼️ One image request renders one page");
  resetSpy();
  const file = await pageImageFile(up.versionId, co.id, 4, "thumb");
  assert("first request: exactly one page drawn, one file", spy.render === 1 && fs.readdirSync(path.dirname(file)).length === 1, spy);
  await pageImageFile(up.versionId, co.id, 4, "thumb");
  assert("second request: served from the cache", spy.render === 1, spy);
  resetSpy();
  await Promise.all([pageImageFile(up.versionId, co.id, 6, "thumb"), pageImageFile(up.versionId, co.id, 6, "thumb")]);
  assert("the same page asked for twice at once is drawn once", spy.render === 1, spy);
  r = await api("GET", pagesApi.pages[0].thumbnailUrl, A);
  assert("thumbnail → image/webp", r.status === 200 && /image\/webp/.test(r.headers.get("content-type")) && r.buffer.subarray(8, 12).toString() === "WEBP");
  r = await api("GET", pagesApi.pages[3].previewUrl, A);
  assert("large preview → image/webp", r.status === 200 && r.buffer.subarray(8, 12).toString() === "WEBP");
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages/10/image`, A);
  assert("a page past the end → 404", r.status === 404);

  console.log("\n🧮 Selection rules");
  const PUT = (body, h = asAdmin, id = up.versionId) => api("PUT", `/catalogue-versions/${id}/page-selection`, h, body);
  r = await api("POST", `/catalogue-versions/${up.versionId}/extract`, asAdmin, {});
  assert("Extract with nothing chosen → 400 EMPTY_SELECTION, nothing queued", r.status === 400 && r.data.code === "EMPTY_SELECTION" && (await prisma.backgroundTask.count({ where: { companyId: co.id, type: "catalogue_extract" } })) === 0, r.data);
  r = await PUT({ pages: [] });
  assert("empty → 400 EMPTY_SELECTION", r.status === 400 && r.data.code === "EMPTY_SELECTION", r.data);
  r = await PUT({ pages: [0, 4] });
  assert("page 0 → 400 PAGE_OUT_OF_RANGE", r.status === 400 && r.data.code === "PAGE_OUT_OF_RANGE" && r.data.pageCount === 9, r.data);
  r = await PUT({ pages: [4, 10] });
  assert("page 10 of 9 → 400 PAGE_OUT_OF_RANGE", r.status === 400 && r.data.code === "PAGE_OUT_OF_RANGE" && r.data.invalid.includes(10), r.data);
  r = await PUT({ pages: [4.5] });
  assert("a non-integer → 400", r.status === 400);
  r = await PUT({ pages: [6, 4, 6] });
  assert("[6, 4, 6] → saved as [4, 6], source user", r.status === 200 && same(r.data.data.selection.pages, [4, 6]) && r.data.data.selection.source === "user", r.data);
  assert("the refused ones changed nothing", same((await prisma.catalogueVersion.findUnique({ where: { id: up.versionId } })).pageSelection.pages, [4, 6]));

  console.log("\n🔒 Tenancy on every endpoint");
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages`, B);
  assert("another company: GET …/pages → 404", r.status === 404, r.status);
  r = await api("GET", pagesApi.pages[0].thumbnailUrl, B);
  assert("another company: page image → 404", r.status === 404, r.status);
  r = await PUT({ pages: [1] }, B);
  assert("another company: PUT …/page-selection refused (403/404)", [403, 404].includes(r.status), r.status);
  r = await api("POST", `/catalogue-versions/${up.versionId}/extract`, B, {});
  assert("another company: POST …/extract refused (403/404)", [403, 404].includes(r.status), r.status);
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages?companyId=${coB.id}`, asAdmin);
  assert("system user scoped to another company (?companyId=) → 404", r.status === 404, r.status);
  r = await api("PUT", `/catalogue-versions/${up.versionId}/page-selection?companyId=${coB.id}`, asAdmin, { pages: [1] });
  assert("system user, PUT with another ?companyId= → 404, selection untouched", r.status === 404 && same((await prisma.catalogueVersion.findUnique({ where: { id: up.versionId } })).pageSelection.pages, [4, 6]), r.status);
  r = await api("GET", `/catalogue-versions/${up.versionId}/pages/1/image?companyId=${coB.id}`, asAdmin);
  assert("system user, image with another ?companyId= → 404", r.status === 404, r.status);
  r = await api("POST", `/catalogue-versions/${up.versionId}/extract?companyId=${coB.id}`, asAdmin, {});
  assert("system user, extract with another ?companyId= → 404", r.status === 404, r.status);

  console.log("\n📖 Extraction reads and segments only the chosen pages; evidence keeps the original page");
  const ag = await upload(pdf, { label: "2022" });
  r = await PUT({ pages: [15, 4, 9] }, asAdmin, ag.versionId);
  assert("keep p.4, 9, 15 → 200", r.status === 200, r.data);
  const calls = [];
  resetSpy();
  const res = await runExtractJob(ag.versionId, undefined, { generate: standIn(calls), infer: false });
  assert("spy: the text layer of exactly 3 pages was read", spy.text === 3, spy);
  const stored = await prisma.catalogueBlock.findMany({ where: { versionId: ag.versionId }, orderBy: { seq: "asc" } });
  assert("blocks exist only on p.4, 9, 15", same([...new Set(stored.map((b) => b.page))], [4, 9, 15]), stored.map((b) => b.page));
  const sentPages = [...new Set(calls.flatMap((c) => [...c.payload.blocks, ...(c.payload.contextBlocks || [])].map((b) => b.page)))].sort((a, b) => a - b);
  assert("only blocks of p.4, 9, 15 were sent, under their original numbers", same(sentPages, [4, 9, 15]), sentPages);
  assert("6 product blocks read (2 per page), in one call (whole pages, ≤ 6 blocks)", res.products === 6 && calls.length === 1, { products: res.products, calls: calls.length });
  assert("the call's ledger context: parent = the catalogue, meta.pages = [4, 9, 15]", calls[0].ctx.parentType === "catalogue" && calls[0].ctx.parentId === ag.catalogueId && same(calls[0].ctx.meta?.pages, [4, 9, 15]) && calls[0].ctx.meta.catalogueId === ag.catalogueId, calls[0].ctx);
  const v = await prisma.catalogueVersion.findUnique({ where: { id: ag.versionId } });
  assert("version.extraction: pages [4, 9, 15] of 18, split file of 3 pages", same(v.extraction.pages, [4, 9, 15]) && v.extraction.pageCount === 18 && v.extraction.split.pages === 3 && same(v.extraction.readPages, [4, 9, 15]), v.extraction);
  const extracted = await prisma.catalogueBlock.findMany({ where: { versionId: ag.versionId, extracted: { not: null } } });
  r = await api("GET", `/catalogue-versions/${ag.versionId}/review`, asAdmin);
  assert("the review lists only the read pages' products", r.status === 200 && r.data.data.counts.products === 6 && r.data.data.blocks.every((b) => [4, 9, 15].includes(b.page)), r.data.data?.counts);
  const onP9 = extracted.filter((b) => b.page === 9);
  r = await api("POST", `/catalogue-blocks/${onP9[0].id}/accept`, asAdmin);
  const product = r.data?.data?.productId ? await prisma.product.findUnique({ where: { id: r.data.data.productId } }) : null;
  assert("an accepted block's product cites its original page (catalogueRef.page = 9, provenance page 9)", product?.catalogueRef?.page === 9 && Object.values(product.fieldProvenance || {}).filter((p) => p.page !== undefined).every((p) => p.page === 9), { status: r.status, ref: product?.catalogueRef });
  assert("pageGroups: whole pages, at most 6 blocks", same(pageGroups([1, 1, 2, 2, 3, 3, 4, 4].map((page, i) => ({ id: i, page })), 6).map((g) => g.map((b) => b.page)), [[1, 1, 2, 2, 3, 3], [4, 4]]));

  console.log("\n🔁 Changing the selection afterwards");
  const onP4 = stored.filter((b) => b.page === 4).map((b) => b.id);
  r = await api("GET", `/catalogue-versions/${ag.versionId}/pages`, A);
  assert("GET pages names the reviewed pages: [9]", same(r.data.data.reviewedPages, [9]), r.data.data.reviewedPages);
  r = await PUT({ pages: [4, 7] }, asAdmin, ag.versionId); // 9 and 15 out, 7 in
  assert("a new selection saves after an extraction", r.status === 200, r.data);
  const again = [];
  resetSpy();
  const res2 = await runExtractJob(ag.versionId, undefined, { generate: standIn(again), infer: false });
  assert("spy: only the new page's text was read", spy.text === 1, spy);
  assert("only p.7 went to the AI, tagged [7]", same([...new Set(again.flatMap((c) => c.payload.blocks.map((b) => b.page)))], [7]) && again.every((c) => same(c.ctx.meta.pages.filter((p) => p !== 4), [7])), again.map((c) => c.ctx.meta));
  assert("2 new products", res2.products === 2, res2);
  const after = await prisma.catalogueBlock.findMany({ where: { versionId: ag.versionId } });
  assert("p.4 kept its rows and values", onP4.every((id) => after.some((b) => b.id === id && b.extracted?.record?.name)));
  assert("p.15's unreviewed blocks were dropped", !after.some((b) => b.page === 15), after.map((b) => b.page));
  assert("on p.9 the accepted block stays, its unreviewed neighbour went", after.filter((b) => b.page === 9).length === 1 && after.find((b) => b.page === 9).id === onP9[0].id);
  r = await api("GET", `/catalogue-versions/${ag.versionId}/review`, asAdmin);
  assert("the review shows p.4, p.7 and the accepted block on p.9", same([...new Set(r.data.data.blocks.map((b) => b.page))].sort((a, b) => a - b), [4, 7, 9]), r.data.data.blocks.map((b) => b.page));
  const v2c = await prisma.catalogueVersion.findUnique({ where: { id: ag.versionId } });
  assert("the extraction records what changed", same(v2c.extraction.newPages, [7]) && same(v2c.extraction.droppedPages.sort((a, b) => a - b), [9, 15]), v2c.extraction);

  console.log("\n📡 Progress lives on the task row");
  const noAi = await upload(pdf, { manufacturer: "Progress test" });
  await PUT({ pages: [4] }, asAdmin, noAi.versionId);
  r = await api("POST", `/catalogue-versions/${noAi.versionId}/extract`, asAdmin, {});
  assert("POST extract queues (202), the version remembers its task", r.status === 202 && (await prisma.catalogueVersion.findUnique({ where: { id: noAi.versionId } })).extractTaskId === r.data.data.jobId, r.data);
  const failed = await pollTask(r.data.data.jobId, asAdmin);
  const row = await prisma.backgroundTask.findUnique({ where: { id: r.data.data.jobId } });
  assert("no AI here: the job fails, its progress stayed on the row", failed.status === "failed" && row.progress > 0 && !!row.message && row.stage === "extract" && row.stages.length === 4, row);
  assert("GET /background-tasks/:id returns progress, message, stage, stages", failed.progress === row.progress && failed.message === row.message && failed.stage === "extract" && failed.stages.find((s) => s.key === "read").status === "done" && failed.stages.find((s) => s.key === "extract").status === "running", failed);
  const noAiV = await prisma.catalogueVersion.findUnique({ where: { id: noAi.versionId } });
  assert("the chosen page was read and kept: enter by hand, or extract again", noAiV.status === "segmented" && !!noAiV.error && (await prisma.catalogueBlock.count({ where: { versionId: noAi.versionId, kind: "product" } })) === 2, noAiV.status);
  await prisma.catalogueVersion.update({ where: { id: noAi.versionId }, data: { status: "extracting" } });
  r = await api("GET", "/catalogues", A);
  const listed = r.data.data.catalogues.flatMap((c) => c.versions).find((x) => x.id === noAi.versionId);
  assert("the list carries a running version's task progress", listed.task?.id === row.id && listed.task.progress === row.progress, listed.task);
  await prisma.catalogueVersion.update({ where: { id: noAi.versionId }, data: { status: "segmented" } });
  r = await api("GET", `/background-tasks/${row.id}`, B);
  assert("another company: GET /background-tasks/:id → 404", r.status === 404, r.status);
  r = await api("POST", `/catalogue-versions/${noAi.versionId}/extract`, asAdmin, {});
  const redo = await pollTask(r.data.data.jobId, asAdmin);
  assert("extracting again doesn't read the page twice (no new page), still fails on the AI", redo.status === "failed" && (await prisma.catalogueBlock.count({ where: { versionId: noAi.versionId, kind: "product" } })) === 2);

  console.log("\n🔁 The next version: offered, not applied");
  const short = await upload(fx, { catalogueId: ag.catalogueId, label: "2023" });
  r = await api("GET", `/catalogue-versions/${short.versionId}/pages`, A);
  assert("v2 starts with nothing selected", r.data.data.selection.pages.length === 0 && (await prisma.catalogueVersion.findUnique({ where: { id: short.versionId } })).pageSelection === null, r.data.data.selection);
  assert("previousSelection = [4, 7] from v1", same(r.data.data.previousSelection?.pages, [4, 7]) && r.data.data.previousSelection.fromVersionId === ag.versionId, r.data.data.previousSelection);
  await PUT({ pages: [4, 15] }, asAdmin, ag.versionId);
  r = await api("GET", `/catalogue-versions/${short.versionId}/pages`, A);
  assert("only pages this file has: p.15 of 9 is left out", same(r.data.data.previousSelection?.pages, [4]), r.data.data.previousSelection);
  const other = await upload(pdf, { manufacturer: "Another maker" });
  r = await api("GET", `/catalogue-versions/${other.versionId}/pages`, A);
  assert("another catalogue of the same company: nothing offered", r.data.data.previousSelection === null, r.data.data.previousSelection);

  console.log("\n🕰️ A version saved with an automatic selection keeps working");
  await prisma.catalogueVersion.update({ where: { id: other.versionId }, data: { pageSelection: { pages: [4, 9], source: "auto", at: new Date().toISOString() } } });
  await prisma.cataloguePage.updateMany({ where: { versionId: other.versionId }, data: { kind: "product", textLength: 2000, reason: "old" } });
  r = await api("GET", `/catalogue-versions/${other.versionId}/pages`, A);
  assert("GET pages returns its selection", same(r.data.data.selection.pages, [4, 9]) && r.data.data.selection.source === "auto", r.data.data.selection);
  const oldCalls = [];
  const oldRes = await runExtractJob(other.versionId, undefined, { generate: standIn(oldCalls), infer: false });
  assert("it extracts", oldRes.products === 4 && oldCalls.length === 1, oldRes);
  await prisma.cataloguePage.deleteMany({ where: { versionId: other.versionId } });
  r = await api("GET", `/catalogue-versions/${other.versionId}/pages`, A);
  assert("a version without page rows gets them from its file", r.status === 200 && r.data.data.pageCount === 18, r.status);
} finally {
  await cleanupCompany(co.id);
  await cleanupCompany(coB.id);
}

await finish(counts);
