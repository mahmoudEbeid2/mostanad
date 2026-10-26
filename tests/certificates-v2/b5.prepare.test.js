// Fill-automatically item 5 (owner, 2026-10-26): "Prepare certificates" on the invoice.
// Stand-in models (no paid API, no internet). Proven here:
//  - one job runs, in order, with named stages and progress: matching → product data → batch-result
//    reuse → supplier COA reading (only when files were uploaded); a stage with nothing to do is skipped
//  - at the end: only what still needs a person — estimated / unconfirmed values (Confirm all) and the
//    lab results still missing — and `canGenerate` as soon as nothing required is open
//  - a second invoice with the same products and batches: the profile and the batch results fill it,
//    0 AI calls, nothing left for a person
//  - the route: 202 + task with the stages in its result; another company → 404
// Needs the guarded stack (npm run dev:test).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, pollTask, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { runPrepareJob, STAGES } from "../../src/services/certificates/prepare/prepareService.js";
import { decideNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { saveGrid, getGrid } from "../../src/services/certificates/labResults/resultsGrid.js";
import { policyToStore } from "../../src/services/certificates/inference/policy.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b5a");
const coB = await createCompany("b5b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

const FIELDS = [
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line", required: false },
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
];
async function invoice(no, lines) {
  const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b5", header: { invoiceNumber: no }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n${lines.map((l, i) => `${i + 1} | ${l.name} | ${l.batch}`).join("\n")}` } });
  for (const [i, l] of lines.entries()) {
    const data = { name: l.name, code: l.code ?? null, batchNo: l.batch, extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data, dataExtracted: data, productId: l.productId ?? null, matchStatus: l.productId ? "matched" : "needs_match", matchMethod: l.productId ? "user" : null } });
  }
  return inv;
}
const calls = { gap: 0, infer: 0, web: 0, coa: 0, match: 0 };
const deps = {
  matchGenerate: async () => {
    calls.match++;
    return { lines: [] };
  },
  generate: async (args) => {
    calls.gap++;
    const gaps = JSON.parse(args.contents[3].slice(6));
    return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) };
  },
  inferGenerate: async (args) => {
    calls.infer++;
    const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
    return { gaps: gaps.map((g) => (g.label === "Storage" ? { gapId: g.gapId, found: true, value: "Store below 25 °C", derivation: "estimate", evidence: [{ path: "description", quote: "Oral solution" }], reasoning: "an oral solution is kept below 25 °C", confidence: 0.6 } : { gapId: g.gapId, found: false, confidence: 0 })) };
  },
  search: async ({ query }) => {
    calls.web++;
    return { fields: query.fields.map((f) => ({ label: f.label, found: false })) };
  },
  fetchPage: async () => ({ ok: false }),
  coaGenerate: async () => {
    calls.coa++;
    return { batches: [{ batchNo: "AV-1", results: [{ labelKey: "ph result", value: "7.2", quote: "pH 6.5-7.5 7.2" }] }] };
  },
};

try {
  const tpl = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: f.key }, data: { inferencePolicy: policyToStore({ dataCategory: f.category, source: f.source, isLabResult: f.isLabResult, label: f.label }, "product_facts_and_web") } });
  const P1 = await prisma.product.create({ data: { companyId: co.id, name: "ADD-E 120", productCode: "ADDE120", description: "Oral solution." } });
  const P2 = await prisma.product.create({ data: { companyId: co.id, name: "ADD-B PLUS", productCode: "ADDBPLUS", description: "Oral solution." } });
  // line 2 has no product yet; its code matches P2 by code (no AI)
  const inv1 = await invoice("B5-1", [{ name: "ADD-E 120 1L", productId: P1.id, batch: "AV-1" }, { name: "ADD-B PLUS 1L", code: "ADDBPLUS", batch: "AV-2" }]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  ["CERTIFICATE OF ANALYSIS — ADD-E 120", "Batch No: AV-1", "Manufacturing date: 03.2026", "pH 6.5-7.5 7.2"].forEach((t, i) => page.drawText(t, { x: 50, y: 780 - i * 22, size: 11, font }));
  const file = await fileStore.putFile({ companyId: co.id, kind: "supplier_coa", buffer: Buffer.from(await doc.save()), mimeType: "application/pdf", originalName: "coa-av1.pdf", ext: "pdf" });
  await prisma.supplierCoa.create({ data: { companyId: co.id, invoiceId: inv1.id, fileId: file.id, fileName: "coa-av1.pdf", mimeType: "application/pdf" } });

  console.log("\n🧪 Prepare: the stages, in order, with progress");
  const events = [];
  const out = await runPrepareJob({ invoiceId: inv1.id }, { progress: (pct, message, extra) => events.push({ pct, stage: extra?.stage }) }, deps);
  const st = Object.fromEntries(out.stages.map((s) => [s.key, s]));
  assert("four named stages, in the owner's order", out.stages.map((s) => s.key).join() === "matching,product_data,batch_results,supplier_coa" && STAGES.length === 4);
  const firstSeen = [...new Set(events.map((e) => e.stage).filter(Boolean))];
  assert("progress reported per stage, in that order, rising", firstSeen.join() === "matching,product_data,batch_results,supplier_coa" && events.every((e, i) => !i || e.pct >= events[i - 1].pct), events);
  assert("matching: line 2 matched by its code (no AI)", st.matching.status === "done" && /1 matched|2 matched/.test(st.matching.detail) && (await prisma.invoiceItem.findFirst({ where: { invoiceId: inv1.id, lineNo: 2 } })).productId === P2.id, st.matching);
  assert("product data: one gap call + one inference call; Storage estimated for both products", st.product_data.status === "done" && calls.gap === 1 && calls.infer === 1, { st: st.product_data, calls });
  assert("batch results: nothing earlier for these batches → skipped", st.batch_results.status === "skipped", st.batch_results);
  assert("supplier COA: the uploaded file read (one call), its value taken", st.supplier_coa.status === "done" && calls.coa === 1 && /1 values taken/.test(st.supplier_coa.detail), st.supplier_coa);
  const p = out.prepared;
  assert("what still needs you: the 2 estimated values (Confirm all) and line 2's pH result", p.estimated === 2 && p.toConfirm.length === 2 && p.toConfirm.every((t) => t.estimated && t.estimateBasis) && p.missingLabResults === 1 && p.missingOther === 0 && p.canGenerate === false, p);
  assert("the job result carries the invoice's AI cost from the ledger", typeof out.cost?.attempts === "number" && "costUsd" in out.cost, out.cost);

  console.log("\n🧪 The person: Confirm all + the results grid → generation possible");
  await decideNeeds(inv1.id, co.id, [{ action: "confirm_all" }], null);
  const grid = await getGrid(inv1.id, co.id);
  const line2 = grid.rows.find((r) => r.lines.some((l) => l.lineNo === 2));
  await saveGrid(inv1.id, co.id, [{ rowKey: line2.rowKey, values: { "ph result": "7.0" } }], null);
  const again = await runPrepareJob({ invoiceId: inv1.id }, {}, deps);
  assert("prepared again: nothing open → canGenerate", again.prepared.canGenerate === true && again.prepared.missing === 0 && again.prepared.toConfirm.length === 0, again.prepared);
  assert("…and it asked no AI the second time (every gap already asked, COA already read)", calls.gap === 1 && calls.infer === 1 && calls.coa === 1, calls);

  console.log("\n🧪 A second invoice with the same products and batches");
  const before = { ...calls };
  const inv2 = await invoice("B5-2", [{ name: "ADD-E 120 1L", productId: P1.id, batch: "AV-1" }, { name: "ADD-B PLUS 1L", productId: P2.id, batch: "AV-2" }]);
  const second = await runPrepareJob({ invoiceId: inv2.id }, {}, deps);
  const s2 = Object.fromEntries(second.stages.map((s) => [s.key, s]));
  assert("matching skipped (every line has a product), supplier COA skipped (none uploaded)", s2.matching.status === "skipped" && s2.supplier_coa.status === "skipped");
  assert("batch results: both lab results reused (the COA's and the typed one)", s2.batch_results.status === "done" && /2 lab results reused/.test(s2.batch_results.detail), s2.batch_results);
  assert("0 AI calls of any kind", JSON.stringify(calls) === JSON.stringify(before), { before, after: calls });
  assert("nothing left for a person: canGenerate straight away", second.prepared.canGenerate === true && second.prepared.toConfirm.length === 0 && second.prepared.missing === 0, second.prepared);

  console.log("\n🧪 The route");
  let r = await api("POST", `/invoices/${inv2.id}/prepare`, A);
  assert("POST …/prepare → 202 with a task and the stage list", r.status === 202 && r.data.data.taskId && r.data.data.stages.length === 4, r.data);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 60_000 });
  assert("the task completes with its stages and what still needs you", task.status === "completed" && task.result.stages.map((s) => s.key).join() === "matching,product_data,batch_results,supplier_coa" && task.result.prepared.canGenerate === true, task.error || task.result);
  r = await api("POST", `/invoices/${inv2.id}/prepare`, B);
  assert("another company → 404", r.status === 404, r.status);
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
