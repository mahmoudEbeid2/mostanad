// Fill-automatically item 1 (owner, 2026-10-24): the lab-result flag and the
// missing-value diagnosis. Stand-in models and pages (no paid API, no internet).
// Proven here:
//  - pre-set: batch data and result / assay / complies / conforms labels; the owner's tick stands
//  - the hard line, on EVERY path: a field flagged isLabResult — with the very same source as a
//    control field that does get filled — is never filled from the catalogue (code), the A2 gap
//    call (product path / product text / catalogue evidence), inference (tier I: not even sent)
//    or the web (tier W: not even asked); only the invoice's own text may prove it
//  - the diagnosis: every missing value with its template field, source path and reason, grouped
//    template_mapping / product_data / lab_result / invoice_data; a path no product has is a
//    mapping problem, not a product gap; tenant-scoped (404 for another company)
// Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, webLookupNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { diagnoseInvoice, classifyMissing } from "../../src/services/certificates/dataNeeds/diagnosis.js";
import { defaultIsLabResult, isLabResult, hardNever, allowsInference, allowsWeb, allowsCatalogue, policyToStore, defaultPolicy } from "../../src/services/certificates/inference/policy.js";
import { askInference } from "../../src/services/certificates/inference/productInference.js";
import { lookupProduct } from "../../src/services/certificates/inference/webLookup.js";
import { verifyEvidence } from "../../src/services/certificates/dataNeeds/evidenceVerifier.js";
import { validateFieldList } from "../../src/services/certificates/templates/fieldService.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b1a");
const coB = await createCompany("b1b");
const B = asCompany(coB.id);

const STORE = "Store below 25 °C in a dry place.";
// the control and the lab result read the SAME source; only the flag differs
const FIELDS = [
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "stability", label: "Stability", source: { kind: "product", path: "storage" }, category: "product_data", isLabResult: true },
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];
const setAi = (c, s) => prisma.company.update({ where: { id: c.id }, data: { aiSettings: { enabled: true, allowInvoiceGapFill: false, allowProductInference: false, allowWebLookup: false, fillVerifiedDirectly: false, rememberProductValues: false, ...s } } });
const needs = async (invoiceId) => Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId } })).map((n) => [n.fieldKey, n]));

async function invoice(c, product, no, { batch = "B-77", text } = {}) {
  const inv = await prisma.invoice.create({
    data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b1", header: { invoiceNumber: no }, headerExtracted: {}, textContent: text ?? `=== Page 1 ===\nINVOICE ${no}\n1 | ${product.name} | ${batch} | 10 KG` },
  });
  const data = { name: product.name, batchNo: batch, extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  return inv;
}

try {
  console.log("\n🧪 Pre-set and policy (pure)");
  assert("pre-set: batch data and result / assay / complies / conforms labels", ["pH result", "Results", "Assay", "Complies", "Conforms to BP"].every((label) => defaultIsLabResult({ label })) && defaultIsLabResult({ label: "Moisture", dataCategory: "batch_data" }));
  assert("…not specifications, names, storage", !["pH", "Specification", "Storage", "Product name"].some((label) => defaultIsLabResult({ label })));
  const lab = { label: "Stability", isLabResult: true, dataCategory: "product_data", source: { kind: "product", path: "storage" }, inferencePolicy: "product_facts_and_web" };
  const control = { ...lab, label: "Storage", isLabResult: false };
  assert("the flag alone draws the hard line: no inference, no web, no catalogue", isLabResult(lab) && hardNever(lab) && !allowsInference(lab) && !allowsWeb(lab) && !allowsCatalogue(lab));
  assert("…the control with the same source may use all three", !hardNever(control) && allowsInference(control) && allowsWeb(control) && allowsCatalogue(control));
  assert("a lab result's stored policy is always never, whatever was requested", policyToStore(lab, "product_facts_and_web") === "never" && defaultPolicy(lab) === "never");
  assert("evidence: a lab result is proven by the invoice text only", (() => {
    const ctx = { value: STORE, labResult: true, product: { storage: STORE }, catalogueAllowed: allowsCatalogue(lab), catalogueBlock: { text: STORE } };
    return ["product_path", "product_json_text", "catalogue_text"].every((type) => !verifyEvidence({ type, path: "storage", quote: STORE }, ctx).ok);
  })());
  {
    const lines = [{ id: "l1", page: 1, text: "pH 3.0-5.0 4.0" }];
    const base = { key: "ph_result", label: "pH result", lineId: "l1", charStart: 11, charEnd: 14, sampleValue: "4.0", source: { kind: "manual" } };
    const v = validateFieldList([base, { ...base, key: "ph", label: "pH", charStart: 3, charEnd: 10, sampleValue: "3.0-5.0", isLabResult: false }], lines);
    assert("validation passes the owner's tick through, omitted stays undefined (kept from storage on save)", !v.problems.length && v.fields[0].isLabResult === undefined && v.fields[1].isLabResult === false, v.problems);
  }

  console.log("\n🧪 Every fill path skips the lab result");
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "Vetline" } });
  const P = { producer: "Vetline Pharma", origin: "TURKEY", description: `Oral solution. ${STORE}`, brandId: brand.id, companyId: co.id };
  const tpl = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  // the A5 migration's backfill for DB-seeded fields (the column default is "never")
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: f.key }, data: { inferencePolicy: policyToStore({ dataCategory: f.category, source: f.source, isLabResult: f.isLabResult }, "product_facts_and_web") } });

  // 1. catalogue (tier C, code): the product's own block prints a STORAGE section
  const cat = await prisma.catalogue.create({ data: { companyId: co.id, manufacturer: "Vetline", brandId: brand.id } });
  const cv = await prisma.catalogueVersion.create({ data: { catalogueId: cat.id, companyId: co.id, label: "2026", sourceFileId: "00000000-0000-4000-8000-0000000000b1", status: "applied", pages: 1 } });
  const text = `VITA LAB\nSTORAGE\n${STORE}\n`;
  const pCat = await prisma.product.create({ data: { ...P, name: "VITA LAB" } });
  const block = await prisma.catalogueBlock.create({ data: { versionId: cv.id, companyId: co.id, seq: 1, page: 3, bbox: { x: 0, y: 0, w: 100, h: 100 }, title: "VITA LAB", text, lines: [], status: "applied", productId: pCat.id } });
  await prisma.product.update({ where: { id: pCat.id }, data: { catalogueRef: { catalogueId: cat.id, catalogueVersionId: cv.id, blockId: block.id, page: 3 } } });
  await setAi(co, { enabled: false });
  let inv = await invoice(co, pCat, "B1-CAT");
  await computeNeeds(inv.id, co.id, { ai: false });
  let n = await needs(inv.id);
  assert("catalogue: the control is offered from the block (tier C)", n.storage.status !== "missing" && n.storage.provenance?.tier === "C", n.storage);
  assert("catalogue: the lab result with the same source stays missing", n.stability.status === "missing" && n.stability.value === null, n.stability);

  // 2. the A2 gap call: the model "finds" both in the product's text and in its catalogue
  const pGap = await prisma.product.create({ data: { ...P, name: "VITA GAP" } });
  await setAi(co, { allowInvoiceGapFill: true });
  inv = await invoice(co, pGap, "B1-GAP", { text: `=== Page 1 ===\nINVOICE B1-GAP\n1 | VITA GAP | B-77 | 10 KG | Stability: complies` });
  const gapCalls = [];
  const gapModel = async (args) => {
    gapCalls.push(args);
    const gaps = JSON.parse(args.contents[3].slice(6));
    return {
      gaps: gaps.map((g) => ({
        gapId: g.gapId,
        found: true,
        value: g.label === "Batch No." ? "B-77" : STORE,
        evidence: g.label === "Batch No." ? [{ type: "invoice_text", quote: "B-77", page: 1 }] : [{ type: "product_json_text", path: "description", quote: STORE }, { type: "catalogue_text", quote: STORE }],
        confidence: 0.95,
      })),
    };
  };
  await computeNeeds(inv.id, co.id, { generate: gapModel });
  n = await needs(inv.id);
  const sent = JSON.parse(gapCalls[0].contents[3].slice(6));
  assert("gap call: the lab result is asked with labResult: true (the model is told)", sent.some((g) => g.label === "Stability" && g.labResult === true) && sent.some((g) => g.label === "Storage" && !g.labResult));
  assert("gap call: product text evidence fills the control (waiting for a person)", n.storage.status === "needs_confirmation" && n.storage.value === STORE, n.storage);
  assert("gap call: the same evidence is refused for the lab result — stays missing", n.stability.status === "missing" && n.stability.value === null, n.stability);
  const refused = await prisma.aiSuggestion.findFirst({ where: { companyId: co.id, kind: "invoice_gap", entityId: n.stability.id } });
  assert("…recorded as a refused suggestion with the reason", refused?.status === "rejected" && /lab result/.test(JSON.stringify(refused.finalValue)), refused?.finalValue);
  // the invoice's own text may prove it
  inv = await invoice(co, pGap, "B1-GAP2", { text: `=== Page 1 ===\nINVOICE B1-GAP2\n1 | VITA GAP | B-77 | 10 KG | Stability: complies` });
  const fromInvoice = async (args) => {
    const gaps = JSON.parse(args.contents[3].slice(6));
    return { gaps: gaps.map((g) => (g.label === "Stability" ? { gapId: g.gapId, found: true, value: "complies", evidence: [{ type: "invoice_text", quote: "Stability: complies", page: 1 }], confidence: 0.9 } : { gapId: g.gapId, found: false, evidence: [], confidence: 0 })) };
  };
  await computeNeeds(inv.id, co.id, { generate: fromInvoice });
  n = await needs(inv.id);
  assert("gap call: a lab result quoted from the invoice's own text IS accepted", n.stability.status === "needs_confirmation" && n.stability.value === "complies" && n.stability.provenance?.kind === "invoice_text", n.stability);

  // 3. inference (tier I): the lab result never reaches the prompt; an answer for it is ignored
  const pInf = await prisma.product.create({ data: { ...P, name: "VITA INF" } });
  await setAi(co, { allowProductInference: true });
  inv = await invoice(co, pInf, "B1-INF");
  const infCalls = [];
  const inferModel = async (args) => {
    infCalls.push(args);
    const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
    const answer = (gapId) => ({ gapId, found: true, value: STORE, derivation: "quoted", evidence: [{ path: "description", quote: STORE }], confidence: 0.9 });
    return { gaps: [...gaps.map((g) => answer(g.gapId)), answer("I2"), answer("I3"), answer("stability")] };
  };
  await computeNeeds(inv.id, co.id, { inferGenerate: inferModel });
  n = await needs(inv.id);
  const infSent = infCalls.length ? JSON.parse(infCalls[0].contents[2].slice(infCalls[0].contents[2].indexOf("\n") + 1)) : [];
  assert("inference: ONE call, the lab result not in it", infCalls.length === 1 && infSent.length === 1 && infSent[0].label === "Storage", infSent);
  assert("inference: the control is inferred, the lab result stays missing", n.storage.status === "inferred" && n.stability.status === "missing", { storage: n.storage.status, stability: n.stability.status });
  {
    const direct = await askInference({ companyId: co.id, invoiceId: inv.id, gaps: [{ gapId: "X1", field: { ...lab }, label: "Stability", expectedType: "string", product: pInf }] }, { generate: inferModel });
    assert("askInference called with only a lab result → nothing sent, nothing answered", direct.sent.length === 0 && direct.answers.size === 0);
  }

  // 4. web (tier W): the lab result is never looked up; an answer for it is refused
  const pWeb = await prisma.product.create({ data: { ...P, name: "VITA WEB", description: "Oral solution." } });
  await setAi(co, { allowWebLookup: true });
  inv = await invoice(co, pWeb, "B1-WEB");
  await computeNeeds(inv.id, co.id, { ai: false });
  const searches = [];
  const page = { ok: true, finalUrl: "https://www.vetline.com/vita-web", host: "www.vetline.com", text: `VITA WEB by Vetline. ${STORE}` };
  const search = async ({ query }) => {
    searches.push(query);
    return { fields: [...query.fields, { label: "Stability" }].map((f) => ({ label: f.label, found: true, value: STORE, sourceType: "manufacturer", citations: [{ url: "https://www.vetline.com/vita-web", title: "t", quote: STORE }], confidence: 0.9 })) };
  };
  await webLookupNeeds(inv.id, co.id, { search, fetchPage: async () => page });
  n = await needs(inv.id);
  assert("web: ONE lookup, the lab result not asked", searches.length === 1 && searches[0].fields.map((f) => f.label).join() === "Storage", searches[0]?.fields);
  assert("web: the control is found on the manufacturer's page, the lab result stays missing", n.storage.status === "web_found" && n.stability.status === "missing", { storage: n.storage.status, stability: n.stability.status });
  {
    const direct = await lookupProduct({ companyId: co.id, invoiceId: inv.id, product: { ...pWeb, brand }, fields: [{ label: "Stability", labelNorm: "stability", field: lab }], allowList: [] }, { search, fetchPage: async () => page });
    const r = direct.results.get("stability");
    assert("lookupProduct with only a lab result → the answer is refused, never verified", !r.verdict.ok && /may not be looked up/.test(r.verdict.reason), r.verdict);
  }

  console.log("\n🧪 Diagnosis: why each value is missing (the production invoice's shape)");
  const DIAG_FIELDS = [
    { key: "product_name", label: "Product Name", source: { kind: "product", path: "name" }, category: "product_data" },
    { key: "ph", label: "pH", source: { kind: "product", path: "specifications.values.Ph" }, category: "product_data" },
    { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
    { key: "constituents", label: "Constituents (per Litre)", source: { kind: "manual" }, sample: "Vitamin E" },
    { key: "field_6", label: "Field 6", source: { kind: "manual" }, category: "unknown", sample: "Sodium selenite" },
    { key: "shelf", label: "Shelf life", source: { kind: "product", path: 'specifications.values["Shelf life"]' }, category: "product_data" },
    { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
    { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
  ];
  const d = await createCompany("b1d");
  try {
    await seedTemplate(d.id, { name: "ADDVET COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: DIAG_FIELDS });
    const p1 = await prisma.product.create({ data: { companyId: d.id, name: "AD3E +CK", specifications: { values: { Ph: "6.0-7.0" } } } });
    const p2 = await prisma.product.create({ data: { companyId: d.id, name: "VITA B+", storage: "Cool, dry place" } });
    const i1 = await invoice(d, p1, "D-1", { batch: "" });
    await prisma.invoiceItem.create({ data: { invoiceId: i1.id, lineNo: 2, data: { name: "VITA B+", batchNo: "VB-9", extra: {} }, dataExtracted: {}, productId: p2.id, matchStatus: "matched", matchMethod: "user" } });
    await computeNeeds(i1.id, d.id, { ai: false });
    const diag = await diagnoseInvoice(i1.id, d.id);
    const g = diag.groups;
    const row = (group, key) => g[group].find((r) => r.fieldKey === key);
    assert("counts: 2 certificates × 8 values, every missing one classified", diag.summary.certificates === 2 && diag.summary.values === 16 && diag.summary.missing === diag.entries.length && Object.values(diag.summary.byGroup).reduce((a, b) => a + b, 0) === diag.summary.missing, diag.summary);
    assert("template mapping: the unnamed “Field 6” (with what it prints), ×2", row("template_mapping", "field_6")?.count === 2 && /unnamed field/.test(row("template_mapping", "field_6").reason) && /Sodium selenite/.test(row("template_mapping", "field_6").reason));
    assert("template mapping: a manual field with no category", row("template_mapping", "constituents")?.count === 2 && /typed by hand/.test(row("template_mapping", "constituents").reason) && row("template_mapping", "constituents").sourcePath === "manual (typed by hand)");
    assert("template mapping: a path NO product of the company has (Shelf life) is a mapping problem", row("template_mapping", "shelf")?.count === 2 && /no product of this company has/.test(row("template_mapping", "shelf").reason) && row("template_mapping", "shelf").sourcePath === 'product.specifications.values["Shelf life"]', row("template_mapping", "shelf"));
    assert("product data: VITA B+ lacks specifications.values.Ph, which another product has", row("product_data", "ph")?.count === 1 && /VITA B\+ has no value at product\.specifications\.values\.Ph \(1 other/.test(row("product_data", "ph").reason), row("product_data", "ph"));
    assert("product data: AD3E +CK lacks storage", g.product_data.some((r) => r.fieldKey === "storage" && r.certificates[0].productName === "AD3E +CK"));
    const labRows = g.lab_result.filter((r) => r.fieldKey === "ph_result");
    assert("lab result: pH result for both lines — the reason names the batch, or says the line has none", labRows.reduce((a, r) => a + r.count, 0) === 2 && labRows.some((r) => /batch VB-9/.test(r.reason)) && labRows.some((r) => /no batch number/.test(r.reason)), labRows.map((r) => r.reason));
    assert("invoice data: the line without a batch number", row("invoice_data", "batch_no")?.count === 1 && /no batchNo/.test(row("invoice_data", "batch_no").reason));
    assert("each entry carries its template field, source path, line and product", diag.entries.every((e) => e.templateName === "ADDVET COA" && e.fieldKey && e.label && e.sourcePath && e.lineNo && e.productName && e.reason));
    assert("the template's active version → no stale-version warning", !diag.staleVersions);
    let r = await api("GET", `/invoices/${i1.id}/data-needs/diagnosis`, asCompany(d.id));
    assert("API: GET …/data-needs/diagnosis → 200 with the same summary", r.status === 200 && r.data.data.diagnosis.summary.missing === diag.summary.missing, r.status);
    r = await api("GET", `/invoices/${i1.id}/data-needs/diagnosis`, B);
    assert("API: another company → 404", r.status === 404, r.status);
    let threw = null;
    try {
      await diagnoseInvoice(i1.id, coB.id);
    } catch (e) {
      threw = e;
    }
    assert("service: another company's scope → not found", threw?.statusCode === 404, threw?.message);
    assert("classify: a deleted field → template mapping", classifyMissing(null, {}).group === "template_mapping");
  } finally {
    await cleanupCompany(d.id);
  }
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
