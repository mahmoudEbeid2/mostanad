// Fill-automatically item 3 (owner, 2026-10-24): product data, filled
// automatically, ON by default. Stand-in models and pages (no paid API, no internet).
// Proven here, on a company with NO stored settings (the defaults):
//  - defaults: inference and web on, verified values filled directly, a product profile, web limits
//  - chain DB → catalogue (code) → invoice/product quote (gap call) → inference → web
//  - a verbatim quote of the product's data / its catalogue / the invoice / the manufacturer's
//    site is filled directly (resolved_ai, filled: "direct"); an estimate (inference from facts,
//    a distributor's page) is filled marked estimated and waits for a person
//  - evidence on every value; no evidence / unverifiable evidence → nothing written
//  - "Confirm all" per invoice; confirmed values go to the product's certificate profile
//  - the next invoice of the same product: values reused from the profile, 0 AI calls, 0 web calls
//  - a person's profile value is never overwritten by an automatic one; lab results never enter it
//  - web: same-product check (name + manufacturer, brand or product code), cache, limits per
//    check and per day, every call an ai_runs row tied to the invoice
//  - tenancy: another company can't read or forget a product's profile
// Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, webLookupNeeds, decideNeeds, usableNeeds, blockingCounts } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { verifyInference } from "../../src/services/certificates/inference/productInference.js";
import { identityOk } from "../../src/services/certificates/inference/webLookup.js";
import { policyToStore } from "../../src/services/certificates/inference/policy.js";
import { rememberValue } from "../../src/services/certificates/dataNeeds/productProfile.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b3a");
const coB = await createCompany("b3b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

const FIELDS = [
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "shelf_life", label: "Shelf life", source: { kind: "product", path: 'specifications.values["Shelf life"]' }, category: "product_data" },
  { key: "origin", label: "Origin", source: { kind: "product", path: "origin" }, category: "product_data" },
  { key: "species", label: "Target species", source: { kind: "product", path: "specifications.values.species" }, category: "product_data" },
  { key: "appearance", label: "Appearance", source: { kind: "product", path: "appearance" }, category: "product_data" },
  { key: "sterility", label: "Sterility", source: { kind: "product", path: "specifications.values.Sterility" }, category: "product_data" },
  { key: "address", label: "Manufacturer address", source: { kind: "product", path: "specifications.values.address" }, category: "product_data" },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];
const STORE = "Store below 25 °C in a dry place.";
const P = {
  description: "Injectable solution for cattle. Shelf life 24 months.",
  physicalForm: "Liquid",
  activeIngredients: [{ name: "Vitamin E", concentration: "50 mg/ml" }, { name: "Selenium", concentration: "0.5 mg/ml" }],
  targetSpecies: ["Cattle", "Sheep"],
  producer: "Vetline Pharma",
  productCode: "VTE-500",
};
const needs = async (invoiceId) => Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId } })).map((n) => [n.fieldKey, n]));

async function invoice(c, product, no, { batch = "B-1", extra = "" } = {}) {
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b3", header: { invoiceNumber: no }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n1 | ${product.name} | ${batch} | 100 BTL${extra}` } });
  const data = { name: product.name, batchNo: batch, extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  return inv;
}

// stand-ins: count calls; answer what each step could really prove
const calls = { gap: 0, infer: 0, web: 0, gapLabels: [] };
const gapModel = async (args) => {
  calls.gap++;
  const gaps = JSON.parse(args.contents[3].slice(6));
  calls.gapLabels.push(gaps.map((g) => g.label));
  return {
    gaps: gaps.map((g) => {
      if (g.label === "Shelf life") return { gapId: g.gapId, found: true, value: "24 months", evidence: [{ type: "product_json_text", path: "description", quote: "Shelf life 24 months." }], confidence: 0.9 };
      if (g.label === "Origin") return { gapId: g.gapId, found: true, value: "TURKEY", evidence: [{ type: "invoice_text", quote: "Origin: TURKEY", page: 1 }], confidence: 0.9 };
      // a claim with no evidence → must not be written
      if (g.label === "Sterility") return { gapId: g.gapId, found: true, value: "Sterile", evidence: [], confidence: 0.99 };
      return { gapId: g.gapId, found: false, evidence: [], confidence: 0 };
    }),
  };
};
const inferModel = async (args) => {
  calls.infer++;
  const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
  return {
    gaps: gaps.map((g) => {
      if (g.label === "Target species") return { gapId: g.gapId, found: true, value: "Cattle", derivation: "derived", derivationKind: "select_from_list", evidence: [{ path: "targetSpecies" }], confidence: 0.8 };
      if (g.label === "Appearance") return { gapId: g.gapId, found: true, value: "Clear yellowish liquid", derivation: "estimate", evidence: [{ path: "physicalForm", quote: "Liquid" }, { path: "description", quote: "Injectable solution" }], reasoning: "an injectable vitamin E solution is a clear yellowish liquid", confidence: 0.6 };
      if (g.label === "Sterility") return { gapId: g.gapId, found: true, value: "Sterile", derivation: "estimate", evidence: [{ path: "description", quote: "Injectable sterile solution" }], reasoning: "injectables are sterile", confidence: 0.7 };
      return { gapId: g.gapId, found: false, confidence: 0 };
    }),
  };
};
const pages = {
  "https://www.vetline.com/vita-e": { ok: true, finalUrl: "https://www.vetline.com/vita-e", host: "www.vetline.com", text: `VITA E-SEL by Vetline. Manufactured at 12 Industrial Zone, Istanbul. ${STORE}` },
  "https://shop.example/vita": { ok: true, finalUrl: "https://shop.example/vita", host: "shop.example", text: "VITA E-SEL (VTE-500). Sterile solution for injection." },
};
const search = async ({ query }) => {
  calls.web++;
  const answers = {
    "Manufacturer address": { found: true, value: "12 Industrial Zone, Istanbul", sourceType: "manufacturer", citations: [{ url: "https://www.vetline.com/vita-e", title: "VITA E-SEL", quote: "Manufactured at 12 Industrial Zone, Istanbul." }], confidence: 0.9 },
    Sterility: { found: true, value: "Sterile", sourceType: "distributor", citations: [{ url: "https://shop.example/vita", title: "shop", quote: "Sterile solution for injection." }], confidence: 0.8 },
  };
  return { fields: query.fields.map((f) => ({ label: f.label, ...(answers[f.label] || { found: false }) })) };
};
const fetchPage = async (url) => pages[url] || { ok: false, reason: "404" };

try {
  console.log("\n🧪 Defaults: fill automatically is ON for a company that never changed its settings");
  let r = await api("GET", "/certificate-ai-settings", A);
  const st = r.data?.data?.settings || {};
  assert("inference and web on; verified values filled directly; a product profile; web limits", st.allowProductInference === true && st.allowWebLookup === true && st.fillVerifiedDirectly === true && st.rememberProductValues === true && st.webLookupMaxProductsPerCheck === 10 && st.webLookupDailyLimit === 30, st);
  r = await api("PATCH", "/certificate-ai-settings", A, { webLookupDailyLimit: 5000 });
  assert("a limit out of range → 400", r.status === 400, r.status);

  console.log("\n🧪 One invoice through the whole chain");
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "Vetline" } });
  const tpl = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: f.key }, data: { inferencePolicy: policyToStore({ dataCategory: f.category, source: f.source, isLabResult: f.isLabResult }, "product_facts_and_web") } });
  const prod = await prisma.product.create({ data: { ...P, name: "VITA E-SEL", companyId: co.id, brandId: brand.id } });
  // its catalogue block prints a STORAGE section (tier C, code)
  const cat = await prisma.catalogue.create({ data: { companyId: co.id, manufacturer: "Vetline", brandId: brand.id } });
  const cv = await prisma.catalogueVersion.create({ data: { catalogueId: cat.id, companyId: co.id, label: "2026", sourceFileId: "00000000-0000-4000-8000-0000000000b3", status: "applied", pages: 1 } });
  const block = await prisma.catalogueBlock.create({ data: { versionId: cv.id, companyId: co.id, seq: 1, page: 7, bbox: { x: 0, y: 0, w: 1, h: 1 }, title: "VITA E-SEL", text: `VITA E-SEL\nSTORAGE\n${STORE}\n`, lines: [], status: "applied", productId: prod.id } });
  await prisma.product.update({ where: { id: prod.id }, data: { catalogueRef: { catalogueId: cat.id, catalogueVersionId: cv.id, blockId: block.id, page: 7 } } });

  const inv1 = await invoice(co, prod, "B3-1", { extra: " | Origin: TURKEY" });
  await computeNeeds(inv1.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  let n = await needs(inv1.id);
  assert("catalogue (code): Storage filled directly, tier C, page 7, with the quote", n.storage.status === "resolved_ai" && n.storage.provenance.tier === "C" && n.storage.provenance.filled === "direct" && n.storage.provenance.page === 7 && n.storage.provenance.quote === STORE, n.storage);
  assert("gap call: Shelf life quoted from the product's own text → filled directly", n.shelf_life.status === "resolved_ai" && n.shelf_life.value === "24 months" && n.shelf_life.provenance.kind === "product_json_text" && n.shelf_life.provenance.filled === "direct", n.shelf_life);
  assert("gap call: Origin quoted from the invoice → filled directly", n.origin.status === "resolved_ai" && n.origin.value === "TURKEY" && n.origin.provenance.kind === "invoice_text", n.origin);
  assert("inference: a code-reproduced selection (species) → filled directly, with its evidence", n.species.status === "resolved_ai" && n.species.value === "Cattle" && n.species.provenance.tier === "I" && n.species.provenance.filled === "direct" && /targetSpecies$/.test(n.species.provenance.evidence[0].path), n.species);
  assert("inference: an estimate → filled, marked estimated, with the facts it came from, waiting", n.appearance.status === "inferred" && n.appearance.value === "Clear yellowish liquid" && n.appearance.provenance.estimated === true && /injectable/.test(n.appearance.provenance.estimateBasis) && n.appearance.provenance.evidence.map((e) => e.quote).join("|") === "Liquid|Injectable solution", n.appearance);
  assert("no evidence → not written: the gap call's bare “Sterile” and the estimate quoting text the product doesn't have", n.sterility.status === "missing" && n.sterility.value === null, n.sterility);
  assert("the lab result was asked of nobody and stays missing", n.ph_result.status === "missing");
  assert("ONE gap call + ONE inference call", calls.gap === 1 && calls.infer === 1, calls);

  // the web: one call for the product's remaining facts
  let view = await webLookupNeeds(inv1.id, co.id, { search, fetchPage });
  n = await needs(inv1.id);
  assert("web: ONE call for the product", calls.web === 1 && view.ai?.web?.calls === 1, view.ai?.web);
  assert("web: the manufacturer's own page → filled directly, with the citation", n.address.status === "resolved_ai" && n.address.value === "12 Industrial Zone, Istanbul" && n.address.provenance.tier === "W" && n.address.provenance.filled === "direct" && n.address.provenance.citations[0].sourceType === "manufacturer", n.address);
  assert("web: a distributor's page (same product, by its code VTE-500) → filled, marked estimated, waiting", n.sterility.status === "web_found" && n.sterility.value === "Sterile" && n.sterility.provenance.estimated === true && n.sterility.provenance.sourceType === "distributor", n.sterility);
  const run = await prisma.aiRun.findFirst({ where: { companyId: co.id, kind: "CERT_WEB_LOOKUP" } });
  assert("the web call is an ai_runs row tied to the product and the invoice", run?.entityId === prod.id && run.outcome === "ok", run);
  assert("identity needs the name plus the maker, brand or product code", identityOk("VITA E-SEL (VTE-500)", { name: "VITA E-SEL", productCode: "VTE-500" }) && !identityOk("VITA E-SEL", { name: "VITA E-SEL", productCode: "VTE-500" }) && !identityOk("VTE-500 by Vetline", { name: "VITA E-SEL", productCode: "VTE-500", producer: "Vetline Pharma" }));
  assert("estimate rules: no reasoning or an unquoted fact → refused", !verifyInference({ found: true, value: "x", derivation: "estimate", evidence: [{ path: "physicalForm", quote: "Liquid" }] }, P).ok && !verifyInference({ found: true, value: "x", derivation: "estimate", evidence: [{ path: "physicalForm" }], reasoning: "r" }, P).ok);

  let open = await blockingCounts(inv1.id);
  assert("only the two estimates and the lab result are left for a person", open.needsConfirmation === 2 && open.missing === 1, open);
  const profile1 = await prisma.productCertificateValue.findMany({ where: { companyId: co.id, productId: prod.id } });
  assert("profile: the five directly filled facts are kept for the product (not the estimates, not the lab result)", profile1.length === 5 && profile1.every((p) => !p.confirmedByUserId && !p.estimated) && !profile1.some((p) => /pH|Appearance|Sterility/.test(p.label)), profile1.map((p) => p.label));

  console.log("\n🧪 Confirm all, then the next invoice of the same product");
  view = await decideNeeds(inv1.id, co.id, [{ action: "confirm_all" }], null);
  n = await needs(inv1.id);
  assert("Confirm all: both estimates accepted", n.appearance.status === "resolved_ai" && n.sterility.status === "resolved_ai" && n.appearance.decidedAt);
  // the lab result is typed for this line
  await decideNeeds(inv1.id, co.id, [{ needId: n.ph_result.id, action: "edit", value: "6.8" }], null);
  open = await blockingCounts(inv1.id);
  assert("…nothing is open on the invoice now", open.needsConfirmation === 0 && open.missing === 0, open);
  const profile2 = await prisma.productCertificateValue.findMany({ where: { companyId: co.id, productId: prod.id } });
  assert("profile: + the two confirmed estimates (estimated, signed by a person); no lab result", profile2.length === 7 && profile2.filter((p) => p.estimated && p.confirmedByUserId).length === 2 && !profile2.some((p) => p.label === "pH result"), profile2.map((p) => [p.label, p.estimated, !!p.confirmedByUserId]));
  const usable = await usableNeeds(inv1.id);
  assert("generation takes every settled value", [...usable.values()][0]?.size === 8, [...usable.values()][0]?.size);

  const before = { ...calls, gapLabels: undefined };
  const inv2 = await invoice(co, prod, "B3-2", { batch: "B-2" });
  view = await computeNeeds(inv2.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  await webLookupNeeds(inv2.id, co.id, { search, fetchPage });
  n = await needs(inv2.id);
  const productFacts = ["storage", "shelf_life", "origin", "species", "appearance", "sterility", "address"];
  assert("second invoice: every product fact reused from the profile", productFacts.every((k) => n[k].status === "reused" && n[k].provenance.kind === "profile"), productFacts.map((k) => `${k}:${n[k].status}`));
  assert("…0 inference and 0 web calls; the one gap call asks only the new batch's lab result (it may be printed on the invoice)", calls.infer === before.infer && calls.web === before.web && calls.gap === before.gap + 1 && calls.gapLabels.at(-1).join() === "pH result", { before, after: calls, asked: calls.gapLabels.at(-1) });
  assert("…the confirmed estimate keeps who signed it and its estimate basis", n.appearance.provenance.estimated === true && n.appearance.provenance.confirmedByUserId && n.appearance.provenance.from.estimateBasis);
  assert("…the lab result is NOT reused across batches: batch B-2 is missing", n.ph_result.status === "missing");
  assert("…and generation takes the reused values", (await usableNeeds(inv2.id)).values().next().value?.get("storage")?.value === STORE);

  console.log("\n🧪 A person's value wins; the web limits");
  await decideNeeds(inv2.id, co.id, [{ needId: n.origin.id, action: "edit", value: "TÜRKIYE" }], null);
  const row = await prisma.productCertificateValue.findFirst({ where: { companyId: co.id, productId: prod.id, label: "Origin" } });
  assert("editing a value updates the profile, signed by a person", row.value === "TÜRKIYE" && row.confirmedByUserId);
  await rememberValue({ companyId: co.id, productId: prod.id, field: FIELDS[2], value: "TURKEY", provenance: { kind: "invoice_text" } });
  assert("an automatic fill never overwrites a person's profile value", (await prisma.productCertificateValue.findUnique({ where: { id: row.id } })).value === "TÜRKIYE");
  assert("a lab result never enters a profile", (await rememberValue({ companyId: co.id, productId: prod.id, field: FIELDS[7], value: "6.8", provenance: {} })) === null);
  assert("a product of another company never gets a profile row", (await rememberValue({ companyId: coB.id, productId: prod.id, field: FIELDS[0], value: "x", provenance: {} })) === null);

  // limits: a second product would need a call, but the company allows 1 web call a day
  await api("PATCH", "/certificate-ai-settings", A, { webLookupDailyLimit: 1 });
  const prod2 = await prisma.product.create({ data: { ...P, name: "VITA E-SEL", productCode: "VTE-501", companyId: co.id, brandId: brand.id } });
  const inv3 = await invoice(co, prod2, "B3-3");
  await computeNeeds(inv3.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  const webBefore = calls.web;
  view = await webLookupNeeds(inv3.id, co.id, { search, fetchPage });
  assert("daily web limit reached → no call, the reason given", calls.web === webBefore && view.ai.web.limited === 1 && /daily web lookup limit/.test(view.ai.web.limitReason), view.ai.web);
  await api("PATCH", "/certificate-ai-settings", A, { webLookupDailyLimit: 30, webLookupMaxProductsPerCheck: 0 });
  view = await webLookupNeeds(inv3.id, co.id, { search, fetchPage });
  assert("per-check product limit → no call, the reason given", calls.web === webBefore && view.ai.web.limited === 1 && /per check/.test(view.ai.web.limitReason), view.ai.web);
  await api("PATCH", "/certificate-ai-settings", A, { webLookupMaxProductsPerCheck: 10 });
  view = await webLookupNeeds(inv3.id, co.id, { search, fetchPage });
  n = await needs(inv3.id);
  assert("within the limits → looked up (a different product: no cache across products)", calls.web === webBefore + 1 && n.address.status === "resolved_ai", calls);

  console.log("\n🧪 Tenancy and forgetting a value");
  r = await api("GET", `/certificate-products/${prod.id}/profile`, A);
  assert("GET …/profile → the product's values", r.status === 200 && r.data.data.values.length === 7, r.status);
  r = await api("GET", `/certificate-products/${prod.id}/profile`, B);
  assert("another company → 404", r.status === 404, r.status);
  r = await api("DELETE", `/certificate-product-values/${row.id}`, B);
  assert("…can't forget it either (404)", r.status === 404 && (await prisma.productCertificateValue.count({ where: { id: row.id } })) === 1, r.status);
  r = await api("DELETE", `/certificate-product-values/${row.id}`, A);
  assert("the owner forgets one value → 204", r.status === 204 && (await prisma.productCertificateValue.count({ where: { id: row.id } })) === 0, r.status);
  const inv4 = await invoice(co, prod, "B3-4", { extra: " | Origin: TURKEY" });
  const g0 = calls.gap;
  await computeNeeds(inv4.id, co.id, { generate: gapModel, inferGenerate: inferModel });
  n = await needs(inv4.id);
  assert("…the next invoice asks for that one again (one gap call), the rest still reused", calls.gap === g0 + 1 && n.origin.status === "resolved_ai" && n.storage.status === "reused", { gap: calls.gap - g0, origin: n.origin.status });
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
