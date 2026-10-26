// Certificate AI layers — post-A4 fixes:
//  1. the certificate data check runs automatically at the end of the extract
//     job, for every new invoice; from then on generate is gated on it (even
//     before anyone opened the review screen). Invoices created before this
//     change (check never run) keep the V2 behaviour.
//  2. matching runs at the end of the extract job and its outcome (counts, AI
//     suggestions or why the AI was unavailable) is stored on the invoice, so
//     the review screen shows it without "Re-run matching".
// The extractor and the models are stand-ins (npm test never calls a paid API).
// Needs the guarded stack (npm run dev:test).
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma, confirmFirst, FIXTURES } from "./helpers.js";
import { seedGoldenCompany, goldenModel, golden } from "./invoiceGoldenHarness.js";
import { runExtractJob } from "../../src/services/certificates/invoices/invoiceService.js";
import { assertDataCheckGate } from "../../src/services/certificates/generation/batchService.js";
import { decideNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const seed = await seedGoldenCompany("pa4");
const cid = seed.company.id;
const A = asCompany(cid);
const empty = await createCompany("pa4e");
// post-A4 confirm-first behaviour; "fill automatically" is proven in b3
for (const c of [cid, empty.id]) await confirmFirst(c);
const PDF = fs.readFileSync(path.join(FIXTURES, "outlined_text.pdf"));

// the extractor's output for INV_A plus a third line code can't match on its own
const { invoice: INV } = golden("INV_A");
const extraLine = { name: "ADD SE oral 1L", code: null, batchNo: "AVSE77", productionDate: null, expiryDate: null, quantity: 5, unit: "PCS", packing: "1L", extra: {} };
const extract = async () => ({
  header: INV.header,
  items: [...INV.lines.map((l, i) => ({ lineNo: i + 1, data: l.data })), { lineNo: 3, data: extraLine, rowText: null }],
  textContent: INV.textContent,
  raw: { header: null },
  provenance: { modelId: "stand-in", promptHash: "stand-in", ms: 1, at: new Date().toISOString(), warnings: [] },
});
const matchModel = (calls) => async (args) => {
  calls.push(args);
  const { lines } = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return { lines: lines.map((l) => ({ lineNo: l.lineNo, productId: l.candidates.find((c) => c.name === "ADD-SE")?.id ?? null, confidence: 0.88, reasons: ["same product"] })) };
};
async function upload(companyId) {
  const src = await fileStore.putFile({ companyId, kind: "invoice_source", buffer: PDF, mimeType: "application/pdf" });
  return prisma.invoice.create({ data: { companyId, status: "uploaded", sourceFileId: src.id } });
}

try {
  console.log("\n🧪 Extraction → matching → data check, in one job");
  const mCalls = [];
  const gCalls = [];
  let inv = await upload(cid);
  const out = await runExtractJob(inv.id, {}, { extract, matchGenerate: matchModel(mCalls), gapsGenerate: goldenModel(golden("INV_A").expected, { calls: gCalls }) });
  inv = await prisma.invoice.findUnique({ where: { id: inv.id }, include: { items: { orderBy: { lineNo: "asc" } } } });
  assert("invoice ready for review", out.status === "review" && inv.status === "review", out);
  assert("lines with a code matched by code; the third one asked to the AI once", inv.items[0].matchMethod === "exact_code" && inv.items[1].matchMethod === "exact_code" && mCalls.length === 1, inv.items.map((i) => i.matchMethod));
  assert("the AI's pick waits on line 3 (auto-accept off)", inv.items[2].matchStatus === "needs_match" && inv.items[2].matchCandidates[0]?.ai?.suggestionId && inv.items[2].matchCandidates[0].name === "ADD-SE", inv.items[2].matchCandidates);
  const ms = inv.matchSummary;
  assert("match summary stored for the review screen: 2 matched, 1 needs a product, AI suggested 1, by extraction", ms?.matched === 2 && ms.needsMatch === 1 && ms.ai.suggested === 1 && ms.ai.calls === 1 && ms.by === "extraction" && ms.at, ms);
  assert("the data check ran automatically (dataCheckedAt, need rows, ONE gap call)", inv.dataCheckedAt && (await prisma.certificateDataNeed.count({ where: { invoiceId: inv.id } })) === 20 && gCalls.length === 1, { at: inv.dataCheckedAt, gCalls: gCalls.length });
  assert("… its result in the job result: 8 verified values waiting for confirmation", out.dataCheck?.needsConfirmation === 8 && out.dataCheck.missing === 0, out.dataCheck);

  console.log("\n🧪 GET /invoices/:id shows both without re-matching");
  let r = await api("GET", `/invoices/${inv.id}`, A);
  assert("matchSummary and dataCheckedAt returned", r.status === 200 && r.data.data.invoice.matchSummary?.by === "extraction" && r.data.data.invoice.dataCheckedAt, r.data?.data?.invoice?.matchSummary);

  console.log("\n🧪 The generate gate applies from extraction on");
  await api("PATCH", `/invoices/${inv.id}/items/${inv.items[2].id}`, A, { ignored: true });
  r = await api("POST", `/invoices/${inv.id}/confirm`, A);
  assert("confirmed (ready)", r.status === 200, r.data);
  inv = await prisma.invoice.findUnique({ where: { id: inv.id } });
  let err = await assertDataCheckGate(inv).catch((e) => e);
  assert("open values → DATA_NEEDS_OPEN, though nobody opened the review panel", err?.code === "DATA_NEEDS_OPEN" && err.statusCode === 409 && err.extra?.needsConfirmation === 8, err);
  r = await api("POST", `/invoices/${inv.id}/generate`, A);
  assert("… the same through the API → 409", r.status === 409 && r.data.code === "DATA_NEEDS_OPEN", r.data);
  err = await assertDataCheckGate(inv, { force: true, canForce: false }).catch((e) => e);
  assert("force without update_certificates → 403", err?.statusCode === 403, err);
  assert("force with it → passes", (await assertDataCheckGate(inv, { force: true, canForce: true })).gated === true);
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: inv.id, status: "needs_confirmation" } });
  await decideNeeds(inv.id, cid, needs.map((n) => ({ needId: n.id, action: "accept" })));
  const ok = await assertDataCheckGate(inv);
  assert("everything confirmed → the gate opens", ok.gated === true && ok.open.missing === 0 && ok.open.needsConfirmation === 0, ok);

  console.log("\n🧪 Invoices from before this change keep the V2 behaviour");
  const src = await fileStore.putFile({ companyId: cid, kind: "invoice_source", buffer: PDF, mimeType: "application/pdf" });
  const legacy = await prisma.invoice.create({ data: { companyId: cid, status: "ready", sourceFileId: src.id, header: { invoiceNumber: "OLD-1" }, headerExtracted: {} } });
  await prisma.invoiceItem.create({ data: { invoiceId: legacy.id, lineNo: 1, data: { name: "ADD-E120" }, dataExtracted: {}, productId: seed.products["ADD-E120"].id, matchStatus: "matched", matchMethod: "user" } });
  const lg = await assertDataCheckGate(legacy);
  assert("check never ran → not gated, and nothing is computed behind its back", lg.gated === false && (await prisma.certificateDataNeed.count({ where: { invoiceId: legacy.id } })) === 0 && !(await prisma.invoice.findUnique({ where: { id: legacy.id } })).dataCheckedAt);

  console.log("\n🧪 Edge cases");
  let noTpl = await upload(empty.id);
  await runExtractJob(noTpl.id, {}, { extract, matchGenerate: matchModel([]), gapsGenerate: goldenModel(golden("INV_A").expected) });
  noTpl = await prisma.invoice.findUnique({ where: { id: noTpl.id } });
  assert("a company without templates: the check still runs (0 values) and marks the invoice checked", noTpl.status === "review" && noTpl.dataCheckedAt && (await prisma.certificateDataNeed.count({ where: { invoiceId: noTpl.id } })) === 0);
  assert("… its gate is on (nothing open → passes)", (await assertDataCheckGate(noTpl)).gated === true);
  let down = await upload(cid);
  const outDown = await runExtractJob(down.id, {}, { extract, matchGenerate: async () => { throw new Error("503 UNAVAILABLE"); }, gapsGenerate: async () => { throw new Error("429 RESOURCE_EXHAUSTED"); } });
  down = await prisma.invoice.findUnique({ where: { id: down.id } });
  assert("AI down for both steps → the extraction still succeeds (review)", down.status === "review" && outDown.status === "review", outDown);
  assert("… match summary says why the AI was unavailable", down.matchSummary.ai.unavailable === true && /503/.test(down.matchSummary.ai.reason), down.matchSummary);
  // item 4: the same lines and batches as the first invoice, whose lab results a person accepted → those 2 are reused by code
  assert("… the check ran by code; its gaps stay missing and are asked next time (the batch's 2 confirmed lab results reused)", down.dataCheckedAt && outDown.dataCheck.missing === 6 && outDown.dataCheck.reused === 2 && outDown.dataCheck.ai.unavailable === true, outDown.dataCheck);
  r = await api("POST", `/invoices/${down.id}/rematch`, A);
  const after = await prisma.invoice.findUnique({ where: { id: down.id } });
  assert("Re-run matching refreshes the stored summary (by: rematch)", r.status === 200 && after.matchSummary.by === "rematch", after.matchSummary);
} finally {
  await finish(counts, async () => {
    for (const c of [cid, empty.id]) await cleanupCompany(c);
  });
}
