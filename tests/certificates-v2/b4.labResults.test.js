// Fill-automatically item 4 (owner, 2026-10-26): lab results, the fastest honest path.
// Stand-in models (no paid API, no internet). Proven here:
//  - a lab result is NEVER filled by inference or the web, on any path: not sent to either,
//    no estimate offered, no product value that inference / the web put there (even confirmed)
//  - "show the specification instead": prints the specification (never one inference produced),
//    never asks for a result, is not in the results grid; the setting survives a save that omits it
//  - results stored per (company, product, batch number): reused on other lines / invoices of
//    the same company + product + batch only, shown "From batch X (invoice …)"
//  - a line without a batch number: the grid asks for it; left empty, its results stay on that
//    line and are never reused, and the check says "No batch number — results can't be reused"
//  - ONE results grid per invoice: rows = batches / lines without one, columns = lab results, the
//    specification next to each cell, out of spec flagged; one save fills every line of the batch
//  - supplier COA: one AI call per document (ai_runs + cost ledger feature), code accepts a value
//    only when it is in the document verbatim (page + quote) and the batch number matches a line;
//    rejected ones listed with the reason; a scan's values wait for a person; a person's value wins
//  - upload route: several files, background job, a failing read recorded (never silent)
//  - tenant isolation everywhere
// Needs the guarded stack (npm run dev:test).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, pollTask, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, webLookupNeeds, decideNeeds, recheckCode } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { rememberBatchResult, normBatch } from "../../src/services/certificates/labResults/batchResults.js";
import { verifyCoa } from "../../src/services/certificates/labResults/coaVerifier.js";
import { runCoaJob, pdfText } from "../../src/services/certificates/labResults/coaService.js";
import { inSpec } from "../../src/services/certificates/labResults/specCheck.js";
import { keepStoredSpecSettings, validateFieldList } from "../../src/services/certificates/templates/fieldService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";
import { FEATURE_BY_RUN_KIND, FEATURES } from "../../src/services/ai/aiLedger.js";
import { policyToStore } from "../../src/services/certificates/inference/policy.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b4a");
const coB = await createCompany("b4b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

const FIELDS = [
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line", required: false },
  { key: "ph_spec", label: "pH specification", source: { kind: "product", path: "specifications.values.pH" }, category: "product_data" },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
  { key: "assay_result", label: "Assay result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
  // the same product path as a control field: the control may use the product's estimate, the lab result never
  { key: "appearance", label: "Appearance", source: { kind: "product", path: "appearance" }, category: "product_data" },
  { key: "appearance_result", label: "Appearance result", source: { kind: "product", path: "appearance" }, category: "product_data", isLabResult: true },
  { key: "moisture_spec", label: "Moisture specification", source: { kind: "product", path: "specifications.values.Moisture" }, category: "product_data" },
  { key: "moisture_shown", label: "Moisture result", source: { kind: "product", path: "specifications.values.Moisture" }, category: "batch_data", isLabResult: true },
  // a product fact no product has: inference IS asked for it (so "never sent a lab result" means something)
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
];
const needs = async (invoiceId) => {
  const rows = await prisma.certificateDataNeed.findMany({ where: { invoiceId } });
  const lineNo = new Map((await prisma.invoiceItem.findMany({ where: { invoiceId }, select: { id: true, lineNo: true } })).map((i) => [i.id, i.lineNo]));
  const out = {};
  for (const r of rows) out[`${lineNo.get(r.invoiceItemId) ?? 0}.${r.fieldKey}`] = r;
  return out;
};
async function invoice(c, no, lines) {
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b4", header: { invoiceNumber: no }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n${lines.map((l, i) => `${i + 1} | ${l.product.name} | ${l.batch ?? ""} | 10 BTL`).join("\n")}` } });
  for (const [i, l] of lines.entries()) {
    const data = { name: l.product.name, ...(l.batch ? { batchNo: l.batch } : {}), extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data, dataExtracted: data, productId: l.product.id, matchStatus: "matched", matchMethod: "user" } });
  }
  return inv;
}
async function coaPdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageLines of lines) {
    const page = doc.addPage([595, 842]);
    pageLines.forEach((t, i) => page.drawText(t, { x: 50, y: 780 - i * 22, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}
async function storeCoa(c, inv, buffer, mimeType, fileName) {
  const f = await fileStore.putFile({ companyId: c.id, kind: "supplier_coa", buffer, mimeType, originalName: fileName, ext: mimeType === "application/pdf" ? "pdf" : "png" });
  return prisma.supplierCoa.create({ data: { companyId: c.id, invoiceId: inv.id, fileId: f.id, fileName, mimeType } });
}

// stand-ins: record what each AI step was asked
const asked = { gap: [], infer: [], web: [] };
const gapModel = async (args) => {
  const gaps = JSON.parse(args.contents[3].slice(6));
  asked.gap.push(...gaps.map((g) => ({ label: g.label, labResult: !!g.labResult })));
  return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) };
};
const inferModel = async (args) => {
  const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
  asked.infer.push(...gaps.map((g) => g.label));
  // would fill ANYTHING it is sent — so nothing lab-result may ever reach it
  return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: true, value: "Inferred", derivation: "estimate", evidence: [{ path: "description", quote: "Injectable" }], reasoning: "guess", confidence: 0.9 })) };
};
const search = async ({ query }) => {
  asked.web.push(...query.fields.map((f) => f.label));
  return { fields: query.fields.map((f) => ({ label: f.label, found: false })) };
};

try {
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "Addvet" } });
  const tpl = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  // every field asks for the loosest policy; the server's clamp decides (a lab result → never)
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: f.key }, data: { inferencePolicy: policyToStore({ dataCategory: f.category, source: f.source, isLabResult: f.isLabResult, label: f.label }, "product_facts_and_web") } });
  await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: "ph_result" }, data: { specFieldKey: "ph_spec" } });
  await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: "moisture_shown" }, data: { showSpecInstead: true, specFieldKey: "moisture_spec" } });
  const base = { description: "Injectable solution.", brandId: brand.id, companyId: co.id };
  // P1: its appearance is an UNCONFIRMED estimate; P2: a CONFIRMED estimate, and its moisture spec came from inference
  const P1 = await prisma.product.create({ data: { ...base, name: "ADD-E 120", appearance: "Clear yellow liquid", specifications: { values: { pH: "6.5 - 7.5", Moisture: "≤ 10 %" } }, fieldProvenance: { appearance: { tier: "I", estimated: true, basis: "guess", at: "2026-10-01" } } } });
  const P2 = await prisma.product.create({ data: { ...base, name: "ADD-B PLUS", appearance: "Clear red liquid", specifications: { values: { pH: "6.0 - 7.0", Moisture: "≤ 12 %" } }, fieldProvenance: { appearance: { tier: "I", estimated: true, basis: "guess", at: "2026-10-01", confirmedAt: "2026-10-02" }, "specifications.values.Moisture": { tier: "I", estimated: true, basis: "guess", at: "2026-10-01", confirmedAt: "2026-10-02" } } } });

  // ── invoice 1: two lines of P1's batch AV-100 (printed differently), P2 with the same batch string, P1 without a batch
  const inv1 = await invoice(co, "B4-1", [{ product: P1, batch: "AV-100" }, { product: P1, batch: "av 100" }, { product: P2, batch: "AV-100" }, { product: P1 }]);
  console.log("\n🧪 A lab result is never filled by inference or the web, on any path");
  await computeNeeds(inv1.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  await webLookupNeeds(inv1.id, co.id, { search, fetchPage: async () => ({ ok: false }) });
  let n = await needs(inv1.id);
  const LAB = ["pH result", "Assay result", "Appearance result", "Moisture result"];
  assert("inference was never sent a lab result", asked.infer.length > 0 && !asked.infer.some((l) => LAB.includes(l)), asked.infer);
  assert("the web was never asked for a lab result", !asked.web.some((l) => LAB.includes(l)), asked.web);
  assert("the gap call may look for a result printed on the invoice only — flagged labResult, never the spec-instead field", asked.gap.filter((g) => LAB.includes(g.label)).every((g) => g.labResult) && !asked.gap.some((g) => g.label === "Moisture result"), asked.gap);
  assert("control: the plain Appearance field is offered P1's estimate (waiting for a person)", n["1.appearance"].status === "inferred" && n["1.appearance"].value === "Clear yellow liquid", n["1.appearance"].status);
  assert("…the lab result reading the same path is NOT (no estimate, missing)", n["1.appearance_result"].status === "missing" && n["1.appearance_result"].value === null, n["1.appearance_result"]);
  assert("P2's confirmed estimate: the plain field resolves it, the lab result still refuses it", n["3.appearance"].status === "resolved" && n["3.appearance_result"].status === "missing", [n["3.appearance"].status, n["3.appearance_result"].status]);
  assert("no lab result was filled by inference anywhere", Object.values(n).filter((x) => /result$/.test(x.fieldKey)).every((x) => x.provenance?.tier !== "I" && x.provenance?.tier !== "W" && x.status !== "inferred" && x.status !== "web_found"), Object.values(n).filter((x) => /result$/.test(x.fieldKey)).map((x) => `${x.fieldKey}:${x.status}`));

  console.log("\n🧪 Show the specification instead");
  assert("P1: the Moisture result prints the specification (≤ 10 %), never asked", ["resolved", "reused"].includes(n["1.moisture_shown"].status) && n["1.moisture_shown"].value === "≤ 10 %", n["1.moisture_shown"]);
  assert("P2: its moisture spec came from inference → not printed as a result (missing, for a person)", n["3.moisture_shown"].status === "missing", n["3.moisture_shown"]);
  const kept = keepStoredSpecSettings([{ key: "moisture_shown" }, { key: "ph_result" }, { key: "ph_spec" }], [{ key: "moisture_shown", showSpecInstead: true, specFieldKey: "moisture_spec" }, { key: "ph_result", showSpecInstead: false, specFieldKey: "ph_spec" }]);
  assert("a save that leaves the setting out keeps it (spec-instead and the grid link)", kept[0].showSpecInstead === true && kept[0].specFieldKey === "moisture_spec" && kept[1].specFieldKey === "ph_spec", kept);
  assert("…a link to a field removed in the same save just goes; an explicit untick stands", keepStoredSpecSettings([{ key: "ph_result" }], [{ key: "ph_result", showSpecInstead: false, specFieldKey: "ph_spec" }])[0].specFieldKey === null && keepStoredSpecSettings([{ key: "m", showSpecInstead: false }], [{ key: "m", showSpecInstead: true, specFieldKey: "s" }])[0].showSpecInstead === false);
  const lines = [{ id: "l1", page: 1, text: "pH 6.5-7.5 7.0" }];
  const f = (o) => ({ key: "x", label: "x", lineId: "l1", charStart: 0, charEnd: 2, sampleValue: "pH", source: { kind: "manual" }, ...o });
  assert("a spec link must name another plain field", validateFieldList([f({ key: "ph_result", specFieldKey: "nope" })], lines).problems.length === 1 && validateFieldList([f({ key: "ph_spec", charStart: 3, charEnd: 10, sampleValue: "6.5-7.5" }), f({ key: "ph_result", charStart: 11, charEnd: 14, sampleValue: "7.0", specFieldKey: "ph_spec" })], lines).problems.length === 0);

  console.log("\n🧪 The results grid");
  let r = await api("GET", `/invoices/${inv1.id}/lab-results`, A);
  let grid = r.data?.data?.grid;
  assert("GET …/lab-results → 200: columns are the lab results, not the spec-instead field", r.status === 200 && grid.columns.map((c) => c.label).join("|") === "pH result|Assay result|Appearance result", grid?.columns);
  const p1Row = grid.rows.find((x) => x.rowKey === `b:${P1.id}:${normBatch("AV-100")}`);
  const p2Row = grid.rows.find((x) => x.rowKey === `b:${P2.id}:${normBatch("AV-100")}`);
  const noBatchRow = grid.rows.find((x) => x.noBatch);
  assert("rows = batches: P1's AV-100 and “av 100” are ONE row (lines 1, 2); P2's AV-100 is its own row", grid.rows.length === 3 && p1Row?.lines.map((l) => l.lineNo).join() === "1,2" && p2Row?.lines.map((l) => l.lineNo).join() === "3", grid.rows.map((x) => [x.rowKey, x.lines.map((l) => l.lineNo)]));
  assert("the line without a batch: its own row, warning “No batch number — results can't be reused”", noBatchRow?.lines[0].lineNo === 4 && noBatchRow.reusable === false && noBatchRow.warning?.message === "No batch number — results can't be reused", noBatchRow);
  assert("the specification is next to each cell (P1 6.5 - 7.5, P2 6.0 - 7.0)", p1Row.cells["ph result"].spec === "6.5 - 7.5" && p2Row.cells["ph result"].spec === "6.0 - 7.0");
  const view = await api("GET", `/invoices/${inv1.id}/data-needs`, A);
  assert("the data check says it too (NO_BATCH_NUMBER, line 4)", view.data.data.check.warnings.some((w) => w.code === "NO_BATCH_NUMBER" && w.lineNo === 4 && /results can't be reused/.test(w.message)), view.data.data.check.warnings);

  r = await api("PUT", `/invoices/${inv1.id}/lab-results`, A, { rows: [{ rowKey: p1Row.rowKey, values: { "ph result": "7.1", "assay result": "99.2 %" } }, { rowKey: p2Row.rowKey, values: { "ph result": "7.4" } }] });
  grid = r.data?.data?.grid;
  const p1 = grid?.rows.find((x) => x.rowKey === p1Row.rowKey);
  const p2 = grid?.rows.find((x) => x.rowKey === p2Row.rowKey);
  assert("PUT → 200: one save fills both lines of P1's batch", r.status === 200 && p1.cells["ph result"].value === "7.1" && p1.cells["assay result"].value === "99.2 %", r.data);
  n = await needs(inv1.id);
  assert("…every need of lines 1 and 2 (a person's value)", n["1.ph_result"].status === "provided" && n["2.ph_result"].status === "provided" && n["2.ph_result"].value === "7.1" && n["2.assay_result"].value === "99.2 %");
  assert("…in spec: 7.1 in 6.5 - 7.5; P2's 7.4 outside 6.0 - 7.0 → highlighted", p1.cells["ph result"].outOfSpec === false && p1.cells["ph result"].inSpec === true && p2.cells["ph result"].outOfSpec === true, [p1.cells["ph result"], p2.cells["ph result"]]);
  const stored = await prisma.batchResult.findMany({ where: { companyId: co.id } });
  assert("…stored per (product, batch): P1 pH + assay, P2 pH — three rows, by a person", stored.length === 3 && stored.every((s) => s.source === "manual" && s.confirmedByUserId) && stored.filter((s) => s.productId === P1.id).length === 2, stored.map((s) => [s.productId === P1.id ? "P1" : "P2", s.labelNorm, s.value]));
  assert("specCheck: conservative — text and two numbers are not judged", inSpec("Complies", "Complies") === null && inSpec("7.1", "Clear liquid") === null && inSpec("6.9", "≤ 7") === true && inSpec("1,2", "NMT 1.0") === false);

  console.log("\n🧪 The line without a batch number");
  r = await api("PUT", `/invoices/${inv1.id}/lab-results`, A, { rows: [{ rowKey: noBatchRow.rowKey, values: { "ph result": "6.9" } }] });
  n = await needs(inv1.id);
  assert("batch left empty: the result stays on that line only (lineOnly), no batch result written", r.status === 200 && n["4.ph_result"].status === "provided" && n["4.ph_result"].provenance.lineOnly === true && (await prisma.batchResult.count({ where: { companyId: co.id } })) === 3, n["4.ph_result"]?.provenance);

  // ── invoice 2: same company, P1 AV-100 again, a new batch, P2 AV-100, P1 without batch
  console.log("\n🧪 Reuse: only the same company + product + batch number");
  const inv2 = await invoice(co, "B4-2", [{ product: P1, batch: "AV100" }, { product: P1, batch: "AV-200" }, { product: P2, batch: "av-100" }, { product: P1 }]);
  await computeNeeds(inv2.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  n = await needs(inv2.id);
  assert("P1 batch AV100 (= AV-100): pH and assay reused from the batch, no AI needed", n["1.ph_result"].status === "reused" && n["1.ph_result"].value === "7.1" && n["1.ph_result"].provenance.kind === "batch_result" && n["1.assay_result"].value === "99.2 %", n["1.ph_result"]);
  assert("P1 batch AV-200: nothing to reuse (another batch)", n["2.ph_result"].status === "missing");
  assert("P2 batch av-100: P2's own 7.4 — never P1's 7.1 (another product)", n["3.ph_result"].value === "7.4", n["3.ph_result"].value);
  assert("P1 without a batch: nothing reused (not even the no-batch line's 6.9)", n["4.ph_result"].status === "missing");
  grid = (await api("GET", `/invoices/${inv2.id}/lab-results`, A)).data.data.grid;
  const reusedCell = grid.rows.find((x) => x.lines.some((l) => l.lineNo === 1)).cells["ph result"];
  assert("the grid shows where: “From batch AV-100 (invoice B4-1)”", reusedCell.source?.text === "From batch AV-100 (invoice B4-1)", reusedCell.source);

  console.log("\n🧪 Tenant isolation");
  const brandB = await prisma.brand.create({ data: { companyId: coB.id, name: "Addvet" } });
  await seedTemplate(coB.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  const PB = await prisma.product.create({ data: { ...base, companyId: coB.id, brandId: brandB.id, name: "ADD-E 120", fieldProvenance: {} } });
  const invB = await invoice(coB, "B4-B", [{ product: PB, batch: "AV-100" }]);
  await computeNeeds(invB.id, coB.id, { ai: false });
  n = await needs(invB.id);
  assert("another company with the same product name and batch: nothing reused", n["1.ph_result"].status === "missing");
  r = await api("GET", `/invoices/${inv1.id}/lab-results`, B);
  assert("another company can't read the grid (404)", r.status === 404, r.status);
  r = await api("PUT", `/invoices/${inv1.id}/lab-results`, B, { rows: [{ rowKey: p1Row.rowKey, values: { "ph result": "1" } }] });
  assert("…or write it (404), and nothing changed", r.status === 404 && (await prisma.batchResult.findFirst({ where: { companyId: co.id, productId: P1.id, labelNorm: "ph result" } })).value === "7.1", r.status);
  assert("a batch result is never written for another company's product", (await rememberBatchResult({ companyId: coB.id, item: { productId: P1.id, data: { batchNo: "AV-100" } }, field: { label: "pH result", isLabResult: true }, value: "1", source: "manual", userId: "x" })) === null);
  assert("…nor from inference, the web or a catalogue", await rememberBatchResult({ companyId: co.id, item: { productId: P1.id, data: { batchNo: "X" } }, field: { label: "pH result", isLabResult: true }, value: "1", source: "inference" }).then(() => false, () => true));

  console.log("\n🧪 Supplier COA verifier (code)");
  const doc = "=== Page 1 ===\nCERTIFICATE OF ANALYSIS\nBatch No: AV-200\npH | 6.5-7.5 | 7.3\nAssay | 98-102 % | 100.4 %\n=== Page 2 ===\nBatch No: AV-1000\npH | 6.5-7.5 | 6.6";
  const vLines = [{ invoiceItemId: "i2", lineNo: 2, productId: "p1", batchNo: "AV-200", labels: [{ labelKey: "ph result", label: "pH result" }, { labelKey: "assay result", label: "Assay result" }] }, { invoiceItemId: "i4", lineNo: 4, productId: "p1", batchNo: null, labels: [{ labelKey: "ph result", label: "pH result" }] }];
  const v = verifyCoa({
    text: doc,
    lines: vLines,
    answer: {
      batches: [
        { batchNo: "AV-200", results: [{ labelKey: "ph result", value: "7.3", quote: "pH 6.5-7.5 7.3" }, { labelKey: "assay result", value: "100.4 %", quote: "Assay | 98-102 % | 100.4 %" }, { labelKey: "moisture", value: "5", quote: "x" }] },
        { batchNo: "AV-999", results: [{ labelKey: "ph result", value: "7.0", quote: "pH | 6.5-7.5 | 7.3" }] },
        { batchNo: "AV-100", results: [{ labelKey: "ph result", value: "6.6", quote: "pH | 6.5-7.5 | 6.6" }] },
      ],
    },
  });
  assert("accepted: batch AV-200's pH 7.3 and assay 100.4 %, page 1, the quote as printed", v.accepted.length === 2 && v.accepted.every((a) => a.page === 1 && a.batchNo === "AV-200") && v.accepted[0].quote === "pH | 6.5-7.5 | 7.3", v.accepted);
  assert("rejected: a batch the document doesn't print (AV-999)", v.rejected.some((x) => x.batchNo === "AV-999" && /not printed in the document/.test(x.reason)), v.rejected);
  assert("rejected: AV-100 is only inside AV-1000 — not the same batch", v.rejected.some((x) => x.batchNo === "AV-100" && /not printed/.test(x.reason)), v.rejected);
  assert("rejected: a result no certificate needs", v.rejected.some((x) => x.labelKey === "moisture" && /not a lab result/.test(x.reason)));
  const v2 = verifyCoa({ text: doc, lines: vLines, answer: { batches: [{ batchNo: "AV-200", results: [{ labelKey: "ph result", value: "7.4", quote: "pH | 6.5-7.5 | 7.4" }, { labelKey: "assay result", value: "101", quote: "Assay | 98-102 % | 100.4 %" }] }, { batchNo: "AV-1000", results: [{ labelKey: "ph result", value: "6.6", quote: "pH | 6.5-7.5 | 6.6" }] }] } });
  assert("rejected: a value not in the document (the quote isn't there)", v2.rejected.some((x) => x.value === "7.4" && /quote is not in the document/.test(x.reason)), v2.rejected);
  assert("rejected: a value not inside its quote", v2.rejected.some((x) => x.value === "101" && /not inside the quote/.test(x.reason)));
  assert("rejected: a batch printed but on no line of this invoice — and the line without a batch number is named", v2.rejected.some((x) => x.batchNo === "AV-1000" && /not the batch number of any line/.test(x.reason) && /line 4 has no batch number/.test(x.reason)), v2.rejected);
  const two = "=== Page 1 ===\nBatch AV-200\npH 7.3\n=== Page 2 ===\nBatch AV-300\npH 7.9";
  const v3 = verifyCoa({ text: two, lines: [...vLines, { invoiceItemId: "i3", lineNo: 3, productId: "p1", batchNo: "AV-300", labels: [{ labelKey: "ph result", label: "pH result" }] }], answer: { batches: [{ batchNo: "AV-200", results: [{ labelKey: "ph result", value: "7.9", quote: "pH 7.9" }] }, { batchNo: "AV-300", results: [{ labelKey: "ph result", value: "7.9", quote: "pH 7.9" }] }] } });
  assert("several batches: a result on another batch's page is rejected, its own accepted", v3.rejected.some((x) => x.batchNo === "AV-200" && /doesn't print batch AV-200/.test(x.reason)) && v3.accepted.length === 1 && v3.accepted[0].batchNo === "AV-300", v3);
  const v4 = verifyCoa({ text: "=== Page 1 ===\nBatch AV-200\npH 7.3\npH (repeat) 7.5", lines: vLines, answer: { batches: [{ batchNo: "AV-200", results: [{ labelKey: "ph result", value: "7.3", quote: "pH 7.3" }, { labelKey: "ph result", value: "7.5", quote: "pH (repeat) 7.5" }] }] } });
  assert("two different values for one batch's result → neither", v4.accepted.length === 0 && v4.rejected.filter((x) => /two different values/.test(x.reason)).length === 2, v4);

  console.log("\n🧪 Supplier COA job (text-layer PDF): one AI call, verified values become the batch's results");
  const pdf = await coaPdf([["CERTIFICATE OF ANALYSIS", "Product: ADD-E 120", "Batch No: AV-200", "pH 6.5-7.5 7.3", "Assay 98-102 % 100.4 %"]]);
  const t = await pdfText(pdf);
  assert("code reads the PDF's text layer, page by page", t.pages === 1 && /=== Page 1 ===/.test(t.text) && /Batch No: AV-200/.test(t.text), t.text);
  const coa1 = await storeCoa(co, inv2, pdf, "application/pdf", "coa-av200.pdf");
  let modelCalls = 0;
  let sawText = false;
  const coaModel = async (args) => {
    modelCalls++;
    sawText = args.contents.some((c) => typeof c === "string" && c.includes("Batch No: AV-200") && c.startsWith("Document text"));
    return { batches: [{ batchNo: "AV-200", results: [{ labelKey: "ph result", value: "7.3", quote: "pH 6.5-7.5 7.3" }, { labelKey: "assay result", value: "100.4 %", quote: "Assay 98-102 % 100.4 %" }] }, { batchNo: "AV-100", results: [{ labelKey: "ph result", value: "7.0", quote: "pH 7.0" }] }] };
  };
  let job = await runCoaJob({ invoiceId: inv2.id, coaIds: [coa1.id] }, {}, { generate: coaModel });
  const c1 = await prisma.supplierCoa.findUnique({ where: { id: coa1.id } });
  assert("ONE call; the model got code's text to quote from", modelCalls === 1 && sawText);
  assert("COA done, text from the PDF, 2 accepted, AV-100 rejected (not printed in it) with the reason", c1.status === "done" && c1.textSource === "pdf_text" && c1.result.accepted.length === 2 && c1.result.rejected.some((x) => x.batchNo === "AV-100" && /not printed/.test(x.reason)), c1.result);
  n = await needs(inv2.id);
  assert("line 2 (AV-200) filled from the COA, reused by code", n["2.ph_result"].status === "reused" && n["2.ph_result"].value === "7.3" && n["2.assay_result"].value === "100.4 %", n["2.ph_result"]);
  const br = await prisma.batchResult.findFirst({ where: { companyId: co.id, productId: P1.id, batchNorm: "AV200", labelNorm: "ph result" } });
  assert("…stored as the batch's result: supplier_coa, page 1, quote, the COA's id", br?.source === "supplier_coa" && br.provenance.page === 1 && br.provenance.quote === "pH 6.5-7.5 7.3" && br.provenance.coaId === coa1.id && !br.confirmedByUserId, br);
  grid = (await api("GET", `/invoices/${inv2.id}/lab-results`, A)).data.data.grid;
  assert("the grid shows “Supplier COA p.1”, and lists the COA's accepted / rejected", grid.rows.find((x) => x.lines.some((l) => l.lineNo === 2)).cells["ph result"].source.text === "Supplier COA p.1" && grid.supplierCoas[0].accepted.length === 2 && grid.supplierCoas[0].rejected.length === 1, grid.supplierCoas);
  const run = await prisma.aiRun.findFirst({ where: { companyId: co.id, kind: "CERT_COA_EXTRACT" } });
  assert("the call is an ai_runs row on the COA (parent: the invoice); its ledger feature is certificates.coa", run?.entityType === "supplier_coa" && run.entityId === coa1.id && run.outcome === "ok" && FEATURE_BY_RUN_KIND.CERT_COA_EXTRACT === "certificates.coa" && FEATURES.includes("certificates.coa"), run);
  job = await runCoaJob({ invoiceId: inv2.id, coaIds: [coa1.id] }, {}, { generate: coaModel });
  assert("a read COA isn't read again (idempotent, 0 calls)", job.skipped === true && modelCalls === 1);

  // invoice 2 has batch AV-100 on a P1 line AND a P2 line: a COA for AV-100 can't be tied to one product
  const av100 = await coaPdf([["CERTIFICATE OF ANALYSIS — ADD-E 120", "Batch No: AV-100", "Manufacturing date: 03.2026", "pH 7.0"]]);
  const av100Model = async () => ({ batches: [{ batchNo: "AV-100", results: [{ labelKey: "ph result", value: "7.0", quote: "pH 7.0" }] }] });
  const coa2 = await storeCoa(co, inv2, av100, "application/pdf", "coa-av100.pdf");
  await runCoaJob({ invoiceId: inv2.id, coaIds: [coa2.id] }, {}, { generate: av100Model });
  const c2 = await prisma.supplierCoa.findUnique({ where: { id: coa2.id } });
  assert("a batch number on lines of two products → rejected, with the reason", c2.result.accepted.length === 0 && /different products/.test(c2.result.rejected[0]?.reason), c2.result);
  // a person's value wins over a COA
  const inv5 = await invoice(co, "B4-5", [{ product: P1, batch: "AV-100" }]);
  await computeNeeds(inv5.id, co.id, { ai: false });
  const coa5 = await storeCoa(co, inv5, av100, "application/pdf", "coa-av100.pdf");
  await runCoaJob({ invoiceId: inv5.id, coaIds: [coa5.id] }, {}, { generate: av100Model });
  const c5 = await prisma.supplierCoa.findUnique({ where: { id: coa5.id } });
  assert("a COA value never replaces a person's (P1 AV-100 pH stays 7.1)", (await prisma.batchResult.findFirst({ where: { companyId: co.id, productId: P1.id, batchNorm: "AV100", labelNorm: "ph result" } })).value === "7.1" && c5.result.accepted[0]?.stored === "kept_person_value", c5.result);

  console.log("\n🧪 A scan: checked against the model's own transcription → a person confirms it");
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const inv3 = await invoice(co, "B4-3", [{ product: P1, batch: "AV-300" }]);
  await computeNeeds(inv3.id, co.id, { ai: false });
  const coa3 = await storeCoa(co, inv3, png, "image/png", "scan.png");
  await runCoaJob({ invoiceId: inv3.id, coaIds: [coa3.id] }, {}, { generate: async () => ({ textContent: "=== Page 1 ===\nLot AV-300\npH 7.2", batches: [{ batchNo: "AV-300", results: [{ labelKey: "ph result", value: "7.2", quote: "pH 7.2" }] }] }) });
  n = await needs(inv3.id);
  const c3 = await prisma.supplierCoa.findUnique({ where: { id: coa3.id } });
  assert("transcription: the value waits for a person (needs_confirmation), not stored for the batch yet", c3.textSource === "transcription" && n["1.ph_result"].status === "needs_confirmation" && n["1.ph_result"].value === "7.2" && !(await prisma.batchResult.count({ where: { companyId: co.id, batchNorm: "AV300" } })), [c3.textSource, n["1.ph_result"].status]);
  await decideNeeds(inv3.id, co.id, [{ needId: n["1.ph_result"].id, action: "accept" }], null);
  const br3 = await prisma.batchResult.findFirst({ where: { companyId: co.id, batchNorm: "AV300" } });
  assert("accepted by a person → the batch's result, keeping the COA it came from", br3?.value === "7.2" && br3.confirmedByUserId && br3.provenance.from?.kind === "supplier_coa", br3);

  console.log("\n🧪 Upload route: several files, a background job, failures recorded");
  const fd = new FormData();
  fd.append("files", new Blob([pdf], { type: "application/pdf" }), "a.pdf");
  fd.append("files", new Blob([png], { type: "image/png" }), "b.png");
  r = await api("POST", `/invoices/${inv1.id}/supplier-coas`, A, fd);
  assert("POST …/supplier-coas (2 files) → 202 with a task and both COAs", r.status === 202 && r.data.data.taskId && r.data.data.coas.length === 2, r.data);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 60_000 });
  const failed = await prisma.supplierCoa.findMany({ where: { invoiceId: inv1.id } });
  assert("the guarded stack can't call Gemini: the task fails and each COA records the real error (never silent)", task.status === "failed" && failed.every((c) => c.status === "failed" && c.error && /GEMINI|Gemini|disabled/i.test(c.error)), failed.map((c) => [c.status, c.error]));
  const bad = new FormData();
  bad.append("files", new Blob([Buffer.from("hello")], { type: "text/plain" }), "x.txt");
  r = await api("POST", `/invoices/${inv1.id}/supplier-coas`, A, bad);
  assert("a file that isn't a PDF / image → 400", r.status === 400, r.data);
  r = await api("POST", `/invoices/${inv1.id}/supplier-coas`, B, fd);
  assert("another company can't upload to the invoice (404)", r.status === 404, r.status);
  r = await api("DELETE", `/invoices/${inv1.id}/supplier-coas/${failed[0].id}`, B);
  assert("…or delete its COA (404)", r.status === 404, r.status);
  r = await api("DELETE", `/invoices/${inv1.id}/supplier-coas/${failed[0].id}`, A);
  assert("the owner deletes a COA → 204", r.status === 204 && !(await prisma.supplierCoa.findUnique({ where: { id: failed[0].id } })), r.status);

  console.log("\n🧪 The grid asks for the batch number; clearing a result");
  const inv4 = await invoice(co, "B4-4", [{ product: P1 }, { product: P1, batch: "AV-500" }]);
  await computeNeeds(inv4.id, co.id, { ai: false });
  grid = (await api("GET", `/invoices/${inv4.id}/lab-results`, A)).data.data.grid;
  const nb = grid.rows.find((x) => x.noBatch);
  r = await api("PUT", `/invoices/${inv4.id}/lab-results`, A, { rows: [{ rowKey: nb.rowKey, batchNo: "AV-500", values: { "ph result": "7.0" } }] });
  grid = r.data?.data?.grid;
  assert("a batch number typed in the grid: the line joins batch AV-500 — one row, both lines filled", r.status === 200 && grid.rows.length === 1 && grid.rows[0].lines.length === 2 && grid.rows[0].cells["ph result"].value === "7.0", grid?.rows);
  const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: inv4.id, lineNo: 1 } });
  assert("…the line keeps it, recorded as typed in the results grid", item.data.batchNo === "AV-500" && item.data.batchNoSource?.via === "results_grid");
  r = await api("PUT", `/invoices/${inv4.id}/lab-results`, A, { rows: [{ rowKey: grid.rows[0].rowKey, batchNo: "X" }] });
  assert("a row that has a batch number can't get another (409)", r.status === 409 && r.data.code === "BATCH_ALREADY_SET", r.data);
  r = await api("PUT", `/invoices/${inv4.id}/lab-results`, A, { rows: [{ rowKey: grid.rows[0].rowKey, values: { "ph result": null } }] });
  n = await needs(inv4.id);
  assert("clearing: both lines missing again, the batch's stored result gone", r.status === 200 && n["1.ph_result"].status === "missing" && n["2.ph_result"].status === "missing" && !(await prisma.batchResult.count({ where: { companyId: co.id, batchNorm: "AV500" } })));
  r = await api("PUT", `/invoices/${inv4.id}/lab-results`, A, { rows: [{ rowKey: grid.rows[0].rowKey, values: { "no such result": "1" } }] });
  assert("a result the row doesn't have → 422", r.status === 422 && r.data.code === "UNKNOWN_RESULT", r.data);
  await recheckCode(inv4.id, co.id);
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
