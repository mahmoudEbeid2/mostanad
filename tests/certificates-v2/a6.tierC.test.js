// Certificate AI layers — Phase A6.2 (plan.md §15.5): tier C in certificates.
// Order: DB path → invoice → catalogue (C) → product inference (I) → web (W).
// Proven here (§15.9 "Tier C"):
//  - "Storage conditions" for an Agrikima product with empty storage resolves from its
//    catalogue block, code only, with a page-cited quote verified against THAT block
//  - SPECIFICATIONS rows fill specification fields ("Assay" → "≥ 50")
//  - a results / batch_data field NEVER resolves from the catalogue — not by code, not
//    through the gap call, not when mis-categorised ("Result" labelled as product data)
//  - no tier C without a linked block, nor from another company's block
//  - the A2 gap call gets the block; catalogue_text evidence is verified against that
//    block only (a neighbour's text is refused) and ranks after DB and invoice evidence
//  - catalogue values wait for a person; "Save to product" promotes one to the DB path
//    with its tier-C provenance; a rejected one is never offered again
//  - an ESTIMATED product value (tier I) needs a person's confirmation before any
//    certificate uses it: offered for confirmation, masked in generation, confirmed once
// Stand-in models only (npm test never calls a paid API). Needs `npm run dev:test`.
import fs from "fs";
import path from "path";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma, readWholeCatalogue, confirmFirst } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, decideNeeds, blockingCounts } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { verifyAnswer } from "../../src/services/certificates/dataNeeds/evidenceVerifier.js";
import { defaultPolicy, allowsCatalogue } from "../../src/services/certificates/inference/policy.js";
import { findCatalogueValue, verifyBlockQuote, specRows, specItemKey } from "../../src/services/catalogues/catalogueSections.js";
import { maskEstimates } from "../../src/services/catalogues/fieldProvenance.js";
import { certificateContext, resolveWithNeed } from "../../src/services/certificates/generation/batchService.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const co = await createCompany("a6c");
const coB = await createCompany("a6d");
// tier C waiting for a person (A6.2); "fill automatically" is proven in b3
for (const c of [co.id, coB.id]) await confirmFirst(c);

const FIELDS = [
  { key: "storage", label: "Storage conditions", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "storage_label", label: "Storage", source: { kind: "manual" }, category: "product_data" },
  { key: "dosage", label: "Dosage", source: { kind: "product", path: "dosage" }, category: "product_data" },
  { key: "pack", label: "Pack size", source: { kind: "manual" }, category: "product_data" },
  { key: "code", label: "Product code", source: { kind: "product", path: "productCode" }, category: "product_data" },
  { key: "assay_spec", label: "Assay", source: { kind: "product", path: "specifications.values.Assay" }, category: "product_data" },
  { key: "assay_result", label: "Assay result", source: { kind: "manual" }, category: "batch_data" },
  { key: "result_mis", label: "Result", source: { kind: "manual" }, category: "product_data" }, // wrongly categorised: the label keeps it out
  { key: "animals", label: "Target animals", source: { kind: "manual" }, category: "product_data" }, // code can't place it → the gap call
  { key: "withdrawal", label: "Withdrawal period", source: { kind: "product", path: "withdrawalPeriod" }, category: "product_data" },
  { key: "batch", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];

async function invoice(c, product, no, text = null) {
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a6", header: { invoiceNumber: no }, headerExtracted: {}, textContent: text || `=== Page 1 ===\nINVOICE ${no}\n1 | ${product.name} | B-77 | 10 x 1L` } });
  const data = { name: product.name, batchNo: "B-77", extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  return inv;
}
const needs = async (invoiceId) => Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId } })).map((n) => [n.fieldKey, n]));
const gapsOf = (args) => JSON.parse(args.contents[3].slice(args.contents[3].indexOf("\n") + 1));

async function uploadFor(c) {
  const r = await api("POST", "/catalogues", asAdmin, form({ companyId: c.id, manufacturer: "Agrikima Sdn. Bhd.", extract: "false" }, { buffer: pdf, name: "agrikima.pdf", type: "application/pdf" }));
  await readWholeCatalogue(r.data.data.versionId);
  return prisma.catalogueBlock.findMany({ where: { versionId: r.data.data.versionId, kind: "product" }, orderBy: { seq: "asc" } });
}

try {
  console.log("\n🧩 Code matching on the sample's blocks (pure)");
  const blocks = await uploadFor(co);
  const blocksB = await uploadFor(coB);
  const B = (title) => blocks.find((b) => b.title === title);
  const storage = { label: "Storage conditions", source: { kind: "product", path: "storage" }, dataCategory: "product_data" };
  let hit = findCatalogueValue(storage, B("Agrizec"));
  assert("Agrizec storage ← its PRECAUTIONS (\"Store in a cool and dry place.\"), page 13", hit?.value === "Store in a cool and dry place." && hit.page === 13 && hit.section === "PRECAUTIONS", hit);
  assert("…and the quote verifies against that block", verifyBlockQuote(B("Agrizec"), hit.quote, hit.value).ok);
  assert("the same quote is NOT accepted against a neighbour's block (Advice ≠ Toxinil)", (() => { const adv = findCatalogueValue(storage, blocks[0]); return adv && !verifyBlockQuote(B("Toxinil"), adv.quote, adv.value).ok && verifyBlockQuote(blocks[0], adv.quote, adv.value).ok; })());
  assert("Advice's STORAGE CONDITION section wins over its precautions line", /original packing/.test(findCatalogueValue(storage, blocks[0])?.value || ""));
  assert("every one of the 29 products has a verified storage value", blocks.every((b) => { const h = findCatalogueValue(storage, b); return h && verifyBlockQuote(b, h.quote, h.value).ok; }));
  assert("SPECIFICATIONS rows: Betaine Assay → \"≥ 50\"; DL-Methionine's two-pair rows split", findCatalogueValue({ label: "Assay", source: { kind: "product", path: "specifications.values.Assay" } }, B("BETAINE 50%"))?.value === "≥ 50" && specRows(B("DL-METHIONINE")).length === 10);
  assert("spec item keys drop units", specItemKey("Assay, %") === "assay" && specItemKey("Pb (mg/kg)") === "pb" && specItemKey("Loss on drying , %") === "loss on drying");
  assert("FORM/CODE table cells: Agrizec → Liquid / AKS12", findCatalogueValue({ label: "Form" }, B("Agrizec"))?.value === "Liquid" && findCatalogueValue({ label: "Product code" }, B("Agrizec"))?.value === "AKS12");
  assert("a value outside its quote, or a quote not in the block → refused", !verifyBlockQuote(B("Agrizec"), "Store in a cool and dry place.", "Keep frozen").ok && !verifyBlockQuote(B("Agrizec"), "Store below 25 °C", "below 25 °C").ok);

  console.log("\n🛑 The hard line (policy)");
  assert("product data → tier C allowed", allowsCatalogue({ dataCategory: "product_data", label: "Storage", source: { kind: "manual" } }) && allowsCatalogue({ label: "Storage", source: { kind: "product", path: "storage" } }));
  assert("batch data / invoice values / results / dates → never", !allowsCatalogue({ dataCategory: "batch_data", label: "Assay" }) && !allowsCatalogue({ dataCategory: "invoice_line", label: "Storage" }) && !allowsCatalogue({ dataCategory: "product_data", label: "Assay result" }) && !allowsCatalogue({ dataCategory: "product_data", label: "Expiry date" }) && !allowsCatalogue({ source: { kind: "item", path: "batchNo" }, label: "x" }));

  console.log("\n📋 The data check: tier C by code");
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "Agrikima" } });
  const ESTIMATE = { tier: "I", estimated: true, basis: "Supplements in this catalogue print 'None.'", modelId: "stand-in", promptHash: "h", at: new Date().toISOString() };
  const agrizec = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "AGRIZEC", withdrawalPeriod: "28 days", fieldProvenance: { withdrawalPeriod: ESTIMATE } } });
  const betaine = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "BETAINE 50%" } });
  const unlinked = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "MENTHOLIC" } });
  for (const [b, p] of [[B("Agrizec"), agrizec], [B("BETAINE 50%"), betaine]]) {
    const r = await api("POST", `/catalogue-blocks/${b.id}/link`, asAdmin, { productId: p.id });
    if (r.status !== 200) throw new Error(`link failed ${r.status}`);
  }
  const t = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: t.versionId, key: f.key }, data: { inferencePolicy: defaultPolicy({ dataCategory: f.category, source: f.source }) } });

  const inv = await invoice(co, agrizec, "A6-1");
  await computeNeeds(inv.id, co.id, { ai: false });
  let n = await needs(inv.id);
  assert("\"Storage conditions\" (empty in the DB) → catalogue_found from the catalogue", n.storage.status === "catalogue_found" && n.storage.value === "Store in a cool and dry place.", n.storage);
  assert("…provenance: tier C, code, version, block, page 13, section, quote", n.storage.provenance?.tier === "C" && n.storage.provenance.via === "code" && n.storage.provenance.blockId === B("Agrizec").id && n.storage.provenance.page === 13 && n.storage.provenance.section === "PRECAUTIONS" && B("Agrizec").text.includes(n.storage.provenance.quote));
  assert("a manual field labelled \"Storage\" → the same value", n.storage_label.status === "catalogue_found" && n.storage_label.value === n.storage.value);
  assert("Dosage → the DOSAGE section, as printed", n.dosage.status === "catalogue_found" && n.dosage.value.startsWith("The recommended dose for poultry:") && n.dosage.value.includes("Young camel: 5 mL per animal/day."));
  assert("Pack size and product code (AKS12) from the block", n.pack.value === "Agrizec is available in 1L bottles and 5L cans." && n.code.value === "AKS12" && n.code.status === "catalogue_found");
  assert("a results field never resolves from the catalogue", n.assay_result.status === "missing" && n.assay_result.value === null);
  assert("…nor a mis-categorised \"Result\" field", n.result_mis.status === "missing" && n.result_mis.value === null);
  assert("invoice values stay code (batch B-77 resolved from the line)", n.batch.status === "resolved" && n.batch.value === "B-77");
  assert("an ESTIMATED product value is offered for confirmation (tier I), not used", n.withdrawal.status === "inferred" && n.withdrawal.value === "28 days" && n.withdrawal.provenance?.kind === "product_estimate" && n.withdrawal.provenance.estimated === true && n.withdrawal.provenance.basis === ESTIMATE.basis);
  const blocking = await blockingCounts(inv.id);
  assert("catalogue and estimated values block generation until confirmed", blocking.needsConfirmation >= 6, blocking);
  const view = (await api("GET", `/invoices/${inv.id}/data-needs`, asCompany(co.id))).data?.data?.check;
  assert("GET /data-needs: summary.catalogueFound and the tier-C provenance", view?.summary?.catalogueFound === 5 && view.certificates[0].needs.find((x) => x.fieldKey === "storage")?.provenance?.tier === "C", view?.summary);

  const invS = await invoice(co, betaine, "A6-2");
  await computeNeeds(invS.id, co.id, { ai: false });
  n = await needs(invS.id);
  assert("Betaine: \"Assay\" specification ← SPECIFICATIONS row \"≥ 50\"", n.assay_spec.status === "catalogue_found" && n.assay_spec.value === "≥ 50" && n.assay_spec.provenance.section === "SPECIFICATIONS", n.assay_spec);
  assert("Betaine: its \"Assay result\" stays missing", n.assay_result.status === "missing");
  assert("Betaine storage spans its two storage lines, verbatim", n.storage.value === "Store in a dry and dark place.\n- Keep away from direct exposure to sunlight.");

  const invU = await invoice(co, unlinked, "A6-3");
  await computeNeeds(invU.id, co.id, { ai: false });
  assert("a product with no linked block → no tier C", (await needs(invU.id)).storage.status === "missing");
  await prisma.product.update({ where: { id: unlinked.id }, data: { catalogueRef: { blockId: blocksB.find((b) => b.title === "Mentholic").id } } });
  await computeNeeds(invU.id, co.id, { ai: false });
  assert("a catalogueRef pointing at ANOTHER company's block → ignored (tenant scope)", (await needs(invU.id)).storage.status === "missing");

  console.log("\n🤖 The A2 gap call gets the block; catalogue_text verified against it only");
  const calls = [];
  const gapModel = async (args) => {
    calls.push(args);
    const gaps = gapsOf(args);
    const id = (label) => gaps.find((g) => g.label === label)?.gapId;
    const out = [];
    if (id("Target animals")) out.push({ gapId: id("Target animals"), found: true, value: "ANIMALS", evidence: [{ type: "catalogue_text", quote: "PROMOTES HEALTH AND GROWTH FOR ANIMALS" }], confidence: 0.8 });
    // a results gap answered from the catalogue → must be refused
    if (id("Assay result")) out.push({ gapId: id("Assay result"), found: true, value: "50", evidence: [{ type: "catalogue_text", quote: "Assay, %\t≥ 50" }], confidence: 0.95 });
    // a quote from ANOTHER product's block → must be refused
    if (id("Result")) out.push({ gapId: id("Result"), found: true, value: "None", evidence: [{ type: "catalogue_text", quote: "Store in a cool and dry place." }], confidence: 0.9 });
    return { gaps: out };
  };
  await computeNeeds(invS.id, co.id, { generate: gapModel });
  n = await needs(invS.id);
  assert("ONE gap call", calls.length === 1, calls.length);
  const sent = JSON.parse(calls[0].contents[2].slice(calls[0].contents[2].indexOf("\n") + 1));
  assert("the call carries the product's catalogue block (page + text)", sent.products[0]?.catalogue?.page === B("BETAINE 50%").page && sent.products[0].catalogue.text.includes("Assay, %"));
  assert("catalogue fields code already filled are not asked", !gapsOf(calls[0]).some((g) => ["Storage conditions", "Assay"].includes(g.label)));
  assert("a product fact quoted from its own block → verified, tier C via the gap call, waiting", n.animals.status === "needs_confirmation" && n.animals.value === "ANIMALS" && n.animals.provenance?.tier === "C" && n.animals.provenance.via === "gap_call" && n.animals.provenance.blockId === B("BETAINE 50%").id, n.animals);
  assert("a results gap answered from the catalogue → refused (stays missing)", n.assay_result.status === "missing" && n.assay_result.value === null);
  const refused = await prisma.aiSuggestion.findFirst({ where: { companyId: co.id, entityId: n.assay_result.id } });
  assert("…recorded as a refused suggestion with the reason", refused?.status === "rejected" && /never comes from a catalogue/.test(JSON.stringify(refused.finalValue)), refused?.finalValue);
  assert("\"Result\" (product data label, hard line) → refused too", n.result_mis.status === "missing");

  const both = verifyAnswer(
    { found: true, value: "Keep cool", evidence: [{ type: "catalogue_text", quote: "Keep cool" }, { type: "invoice_text", quote: "Keep cool" }] },
    { textContent: "=== Page 1 ===\nKeep cool", scope: "header", otherSpans: [], catalogueAllowed: true, catalogueBlock: { id: "b", versionId: "v", page: 1, text: "Keep cool" } }
  );
  assert("evidence ranks DB → invoice → product text → catalogue", both.verified && both.provenance.kind === "invoice_text", both.provenance);
  const neighbour = verifyAnswer({ found: true, value: "Keep cool", evidence: [{ type: "catalogue_text", quote: "Keep cool" }] }, { catalogueAllowed: true, catalogueBlock: { id: "b", versionId: "v", page: 1, text: "Store dry" } });
  assert("a quote not in the product's own block → not verified", !neighbour.verified && /not in this product's catalogue block/.test(neighbour.reason));

  console.log("\n✍️ A person decides — save to product, reject, estimates");
  n = await needs(inv.id);
  await decideNeeds(inv.id, co.id, [
    { needId: n.storage.id, action: "accept", saveToProduct: true },
    { needId: n.code.id, action: "accept" },
    { needId: n.pack.id, action: "reject" },
    { needId: n.withdrawal.id, action: "accept", saveToProduct: true },
  ]);
  let p = await prisma.product.findUnique({ where: { id: agrizec.id } });
  assert("Save to product: storage written to the product", p.storage === "Store in a cool and dry place.");
  assert("…with its tier-C provenance (block, page, quote) and who confirmed it", p.fieldProvenance?.storage?.tier === "C" && p.fieldProvenance.storage.blockId === B("Agrizec").id && p.fieldProvenance.storage.page === 13 && p.fieldProvenance.storage.quote && p.fieldProvenance.storage.confirmedAt, p.fieldProvenance);
  assert("accept without saving: the product is untouched (no code written)", p.productCode === null);
  assert("the estimate is confirmed on the product, value unchanged", p.withdrawalPeriod === "28 days" && p.fieldProvenance.withdrawalPeriod.estimated === true && !!p.fieldProvenance.withdrawalPeriod.confirmedAt);
  await computeNeeds(inv.id, co.id, { ai: false });
  n = await needs(inv.id);
  assert("next check: storage now resolves by the DB path (code)", n.storage.status === "resolved" && n.storage.provenance?.kind === "path");
  assert("next check: the confirmed estimate resolves by code", n.withdrawal.status === "resolved" && n.withdrawal.value === "28 days");
  assert("a rejected catalogue value is not offered again", n.pack.status === "missing" && n.pack.value === null);
  assert("the accepted-for-this-invoice code stays accepted", n.code.status === "resolved_ai" && n.code.value === "AKS12");
  const inv2 = await invoice(co, agrizec, "A6-4");
  await computeNeeds(inv2.id, co.id, { ai: false });
  const n2 = await needs(inv2.id);
  assert("a NEW invoice of the same product: storage by code, 0 decisions needed for it", n2.storage.status === "resolved" && n2.withdrawal.status === "resolved");
  assert("…while the code, saved for one invoice only, is offered again", n2.code.status === "catalogue_found");

  console.log("\n🖨️ Generation never prints an unconfirmed estimate");
  const est = await prisma.product.create({ data: { companyId: co.id, name: "EST", withdrawalPeriod: "5 days", appearance: "clear liquid", fieldProvenance: { withdrawalPeriod: ESTIMATE } } });
  assert("maskEstimates empties only unconfirmed estimates", maskEstimates(est).withdrawalPeriod === null && maskEstimates(est).appearance === "clear liquid" && est.withdrawalPeriod === "5 days");
  const ctx = await certificateContext({ scope: "per_product", companyId: co.id, productId: est.id, items: [] }, { invoice: { header: {} }, company: {}, today: new Date() }, { products: new Map() }, { version: { template: {} } });
  const wField = FIELDS.find((f) => f.key === "withdrawal");
  assert("certificate context: the estimate is empty → nothing printed", resolveWithNeed(wField, ctx, null).value === "");
  assert("…unless the data check holds a person's accepted value", resolveWithNeed(wField, ctx, { id: "x", value: "5 days", status: "resolved_ai", provenance: { kind: "product_estimate" } }).value === "5 days");
  assert("…and an appearance that is not an estimate prints as before", resolveWithNeed({ key: "a", source: { kind: "product", path: "appearance" } }, ctx, null).value === "clear liquid");
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await cleanupCompany(co.id);
  await cleanupCompany(coB.id);
});
