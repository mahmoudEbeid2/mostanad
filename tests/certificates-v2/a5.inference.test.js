// Certificate AI layers — Phase A5 (plan.md §14): inference from product data
// (tier I) and web lookup with verified citations (tier W). Stand-in models and
// pages (npm test never calls a paid API or the internet).
// Proven here (§14.6):
//  - the hard line: batch data / invoice values / "never" fields never reach tiers I/W,
//    even when the model returns values for them, even when the stored policy says otherwise
//  - tier I: quoted values and the four allow-listed derivations re-run by code; a derived
//    value code can't reproduce → rejected; free-form reasoning → rejected
//  - tier W: the page must hold the quote (value inside) and name the product + its maker;
//    source ranking (registry / manufacturer / allow-listed / distributor with warning /
//    other rejected); registration numbers from a registry only
//  - always a person's decision; save-to-product → next invoice by code, 0 AI calls
//  - cache: the same fact → 0 web calls; company-scoped; no invoice data in the query
//  - toggles off → identical to A2; web lookup never during the check/upload
// Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma, confirmFirst } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, webLookupNeeds, decideNeeds, blockingCounts } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { defaultPolicy, effectivePolicy, policyToStore, hardNever, allowsInference, allowsWeb } from "../../src/services/certificates/inference/policy.js";
import { verifyInference, productRecord } from "../../src/services/certificates/inference/productInference.js";
import { verifyWebAnswer, identityOk, classifySource } from "../../src/services/certificates/inference/webLookup.js";
import { convertUnits, verifyDerived } from "../../src/services/certificates/inference/derivations.js";
import { resolveWithNeed } from "../../src/services/certificates/generation/batchService.js";

const { assert, counts } = makeAssert();
const co = await createCompany("a5a");
const coB = await createCompany("a5b");
const A = asCompany(co.id);
const B = asCompany(coB.id);
// A5's confirm-first behaviour (always a person, web only on request); "fill automatically" is proven in b3
for (const c of [co.id, coB.id]) await confirmFirst(c);

const PRODUCT = {
  name: "VITAPLUS E",
  producer: "AFAQ Additives Feed Company",
  origin: "JORDAN",
  description: "Oral solution for poultry. Store below 25 °C in a dry place, away from light.",
  appearance: "light yellow liquid",
  targetSpecies: ["Poultry", "Cattle"],
  activeIngredients: [{ name: "Vitamin E", concentration: "120 g/L" }, { name: "Selenium", concentration: "0.5 g/L" }],
  specifications: { values: { "Vitamin E": "120 g/L" } },
};
const FIELDS = [
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "species", label: "Species", source: { kind: "product", path: "specifications.values.species" }, category: "product_data" },
  { key: "composition", label: "Composition", source: { kind: "product", path: "specifications.values.composition" }, category: "product_data" },
  { key: "vit_e_mg", label: "Vitamin E (mg/L)", source: { kind: "product", path: "specifications.values.vitEmgL" }, category: "product_data" },
  { key: "appearance_caps", label: "Appearance (capitals)", source: { kind: "product", path: "specifications.values.appearanceCaps" }, category: "product_data" },
  { key: "address", label: "Manufacturer address", source: { kind: "product", path: "specifications.values.address" }, category: "product_data" },
  { key: "reg_no", label: "Registration No.", source: { kind: "product", path: "registrationNumber" }, category: "product_data" },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data" },
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];

async function seedCompany(c, name = PRODUCT.name) {
  const brand = await prisma.brand.create({ data: { companyId: c.id, name: "ADDvet" } });
  const product = await prisma.product.create({ data: { ...PRODUCT, name, companyId: c.id, brandId: brand.id } });
  const t = await seedTemplate(c.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  // the migration's backfill for these DB-seeded fields
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: t.versionId, key: f.key }, data: { inferencePolicy: defaultPolicy({ dataCategory: f.category, source: f.source }) } });
  return { product, ...t };
}
async function invoice(c, product, no) {
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a5", header: { invoiceNumber: no, customerName: "SECRET CUSTOMER LLC" }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n1 | ${product.name} | B-77 | USD 999.00` } });
  const data = { name: product.name, batchNo: "B-77", extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  return inv;
}
const noGaps = async (args) => ({ gaps: JSON.parse(args.contents[3].slice(6)).map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) });
const needs = async (invoiceId) => Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId } })).map((n) => [n.fieldKey, n]));

// the stand-in for tier I: correct answers, plus values for fields it must never get
const inferModel = (calls, extra = {}) => async (args) => {
  calls.push(args);
  const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
  const by = (label) => gaps.find((g) => g.label === label)?.gapId;
  const answers = [
    { label: "Storage", found: true, value: "Store below 25 °C in a dry place", derivation: "quoted", evidence: [{ path: "description", quote: "Store below 25 °C in a dry place" }], confidence: 0.9 },
    { label: "Species", found: true, value: "Poultry", derivation: "derived", derivationKind: "select_from_list", evidence: [{ path: "targetSpecies" }], confidence: 0.8 },
    { label: "Composition", found: true, value: "Vitamin E 120 g/L, Selenium 0.5 g/L", derivation: "derived", derivationKind: "join_list", params: { fields: ["name", "concentration"], separator: ", " }, evidence: [{ path: "activeIngredients" }], confidence: 0.85 },
    { label: "Vitamin E (mg/L)", found: true, value: "120000 mg/L", derivation: "derived", derivationKind: "unit_conversion", params: { to: "mg/L" }, evidence: [{ path: 'specifications.values["Vitamin E"]', quote: "120 g/L" }], confidence: 0.9 },
    { label: "Appearance (capitals)", found: true, value: "LIGHT YELLOW LIQUID", derivation: "derived", derivationKind: "normalize_case", params: { case: "upper" }, evidence: [{ path: "appearance", quote: "light yellow liquid" }], confidence: 0.9 },
    // free-form reasoning dressed as a derivation → must be refused
    { label: "Manufacturer address", found: true, value: "Amman, Jordan", derivation: "derived", derivationKind: null, evidence: [{ path: "origin", quote: "JORDAN" }], reasoning: "AFAQ is a Jordanian company, so probably Amman", confidence: 0.7 },
    // values for fields that must never be filled (they are not even sent; answer anyway with made-up gap ids)
    { gapId: "I-ph", found: true, value: "4.0", derivation: "quoted", evidence: [{ path: "description", quote: "Oral solution" }], confidence: 1 },
    ...(extra.answers || []),
  ];
  return { gaps: answers.map((a) => ({ gapId: a.gapId || by(a.label) || `x-${a.label}`, ...a })) };
};

try {
  console.log("\n🧪 Policy — the hard line in code (§14.1)");
  assert("defaults: product data → product_facts_and_web; batch/invoice/company/constant → never", defaultPolicy({ dataCategory: "product_data" }) === "product_facts_and_web" && ["batch_data", "invoice_line", "invoice_header", "company", "constant"].every((c) => defaultPolicy({ dataCategory: c }) === "never"));
  assert("a person can tighten, never loosen past never", policyToStore({ dataCategory: "batch_data" }, "product_facts_and_web") === "never" && policyToStore({ dataCategory: "product_data" }, "product_facts") === "product_facts" && policyToStore({ dataCategory: "product_data" }, "never") === "never");
  assert("hard line beats a wrongly stored policy: item sources, batch/date/qty/result labels, group cells", effectivePolicy({ dataCategory: "product_data", inferencePolicy: "product_facts_and_web", source: { kind: "product", path: "x" }, label: "Expiry date" }) === "never" && hardNever({ source: { kind: "item", path: "batchNo" } }) && hardNever({ label: "Assay result", source: { kind: "product" } }) && hardNever({ groupKey: "g", source: { kind: "row" } }) && !hardNever({ label: "Storage", source: { kind: "product" } }));
  assert("registration numbers: no tier I; tier W allowed (registry only, checked later)", !allowsInference({ dataCategory: "product_data", label: "Registration No.", source: { kind: "product", path: "registrationNumber" } }) && allowsWeb({ dataCategory: "product_data", label: "Registration No.", source: { kind: "product", path: "registrationNumber" } }));

  console.log("\n🧪 Derivations re-run by code (§14.2)");
  assert("unit conversion", convertUnits("120 g/L", "mg/L") === "120000 mg/l" && convertUnits("1.5 kg", "g") === "1500 g" && convertUnits("5 g", "ml") === null);
  assert("a derived value code can't reproduce → rejected", !verifyDerived("unit_conversion", "120 g/L", { to: "mg/L" }, "12000 mg/L").ok && !verifyDerived("select_from_list", ["Poultry"], {}, "Sheep").ok && !verifyDerived("guessing", "x", {}, "x").ok);
  const P0 = { ...PRODUCT, brand: { name: "ADDvet" } };
  assert("a quote that isn't in the product → rejected", !verifyInference({ found: true, value: "below 30 °C", derivation: "quoted", evidence: [{ path: "description", quote: "Store below 30 °C" }] }, P0).ok);
  assert("quoted value outside its quote → rejected", !verifyInference({ found: true, value: "Keep frozen", derivation: "quoted", evidence: [{ path: "description", quote: "Store below 25 °C" }] }, P0).ok);
  assert("no evidence / unknown derivation → rejected", !verifyInference({ found: true, value: "x", derivation: "quoted", evidence: [] }, P0).ok && !verifyInference({ found: true, value: "x", derivation: "vibes", evidence: [{ path: "name" }] }, P0).ok);
  assert("the prompt record: every column, category/brand names, no ids", (() => { const r = productRecord({ ...P0, id: "secret-id", companyId: "c", category: { name: "Feed" } }); return r.name && r.description && r.brand.name === "ADDvet" && r.category.name === "Feed" && !("id" in r) && !("companyId" in r); })());

  console.log("\n🧪 Tier W verification (§14.3)");
  const pageFor = (pages) => async (url) => pages[url] || { ok: false, reason: "404" };
  const goodPage = { ok: true, finalUrl: "https://www.addvet.com/vitaplus", host: "www.addvet.com", text: "VITAPLUS E by ADDvet. Manufactured by AFAQ at 12 Industrial Zone, Amman. Store below 25 °C." };
  const ans = (url, quote, value, sourceType = "manufacturer") => ({ found: true, value, sourceType, citations: [{ url, title: "t", quote }] });
  const field = { dataCategory: "product_data", label: "Manufacturer address", source: { kind: "product", path: "specifications.values.address" } };
  let v = await verifyWebAnswer(ans("https://addvet.com/v", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone, Amman"), { product: P0, field, fetchPage: pageFor({ "https://addvet.com/v": goodPage }) });
  assert("manufacturer page with the quote, about this product → accepted (host matches the brand)", v.ok && v.citation.sourceType === "manufacturer" && v.citation.finalUrl === goodPage.finalUrl, v);
  v = await verifyWebAnswer(ans("https://addvet.com/v", "Manufactured by AFAQ at 99 Other Street", "99 Other Street"), { product: P0, field, fetchPage: pageFor({ "https://addvet.com/v": goodPage }) });
  assert("a citation whose page lacks the quote → rejected", !v.ok && /not on the page/.test(v.reason), v.reason);
  v = await verifyWebAnswer(ans("https://addvet.com/o", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone, Amman"), { product: P0, field, fetchPage: pageFor({ "https://addvet.com/o": { ...goodPage, text: "VITAMAX D3 by ADDvet. Manufactured by AFAQ at 12 Industrial Zone, Amman." } }) });
  assert("a page about a different product → rejected", !v.ok && /not about this product/.test(v.reason), v.reason);
  const blog = { ok: true, finalUrl: "https://vetblog.example/p", host: "vetblog.example", text: goodPage.text };
  v = await verifyWebAnswer(ans("https://vetblog.example/p", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone, Amman", "other"), { product: P0, field, fetchPage: pageFor({ "https://vetblog.example/p": blog }) });
  assert("an untrusted domain → rejected", !v.ok && /untrusted source/.test(v.reason), v.reason);
  v = await verifyWebAnswer(ans("https://vetblog.example/p", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone, Amman", "other"), { product: P0, field, allowList: ["vetblog.example"], fetchPage: pageFor({ "https://vetblog.example/p": blog }) });
  assert("… accepted once the company allow-lists it", v.ok && v.citation.sourceType === "allow_listed");
  v = await verifyWebAnswer(ans("https://vetblog.example/p", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone, Amman", "distributor"), { product: P0, field, fetchPage: pageFor({ "https://vetblog.example/p": blog }) });
  assert("a distributor → accepted with a warning", v.ok && v.citation.sourceType === "distributor" && /distributor/.test(v.citation.warning));
  const regField = { dataCategory: "product_data", label: "Registration No.", source: { kind: "product", path: "registrationNumber" } };
  v = await verifyWebAnswer(ans("https://vetblog.example/p", "Manufactured by AFAQ at 12 Industrial Zone, Amman", "12 Industrial Zone", "distributor"), { product: P0, field: regField, fetchPage: pageFor({ "https://vetblog.example/p": blog }) });
  assert("a registration number from a non-registry page → rejected", !v.ok && /official registry/.test(v.reason), v.reason);
  const reg = { ok: true, finalUrl: "https://www.edaegypt.gov.eg/r/1", host: "www.edaegypt.gov.eg", text: "Registry: VITAPLUS E — ADDvet / AFAQ. Registration No. VR-4471." };
  v = await verifyWebAnswer(ans("https://edaegypt.gov.eg/r/1", "Registration No. VR-4471", "VR-4471", "official_registry"), { product: P0, field: regField, fetchPage: pageFor({ "https://edaegypt.gov.eg/r/1": reg }) });
  assert("… accepted from an official registry", v.ok && v.citation.sourceType === "official_registry", v);
  v = await verifyWebAnswer(ans("https://addvet.com/v", "Manufactured by AFAQ", "12 Industrial Zone"), { product: P0, field, fetchPage: pageFor({ "https://addvet.com/v": goodPage }) });
  assert("the value must be inside the quote", !v.ok && /inside the quote/.test(v.reason));
  v = await verifyWebAnswer(ans("https://down.example/x", "q 1", "1"), { product: P0, field, fetchPage: pageFor({}) });
  assert("an unreachable page → rejected with the reason", !v.ok && /404/.test(v.reason));
  assert("identity needs the name AND the maker/brand", identityOk("VITAPLUS E from ADDvet", P0) && !identityOk("VITAPLUS E", P0) && !identityOk("ADDvet AFAQ", P0));
  assert("source ranking by the real host", classifySource("www.addvet.com", P0, "other").type === "manufacturer" && classifySource("sfda.gov.sa", P0, "other").type === "official_registry" && classifySource("x.example", P0, "manufacturer").accepted === false);

  console.log("\n🧪 Toggles off → identical to A2 (§14.6)");
  const s1 = await seedCompany(co);
  let inv = await invoice(co, s1.product, "A5-1");
  const iCalls = [];
  let check = await computeNeeds(inv.id, co.id, { generate: noGaps, inferGenerate: inferModel(iCalls) });
  let n = await needs(inv.id);
  assert("no inference call; every gap stays missing; tiers reported off", iCalls.length === 0 && ["storage", "species", "address"].every((k) => n[k].status === "missing") && check.tiers.inference === false && check.tiers.web === false && check.ai.inference.off === true);
  const sCalls = [];
  check = await webLookupNeeds(inv.id, co.id, { search: async (a) => (sCalls.push(a), { fields: [] }) });
  assert("web lookup off → no call, the reason given", sCalls.length === 0 && check.ai.web.unavailable && /turned off/.test(check.ai.web.reason));

  console.log("\n🧪 Tier I — inference from the product's own data (§14.2)");
  await api("PATCH", "/certificate-ai-settings", A, { allowProductInference: true, autoAccept: true, autoAcceptThreshold: 0.5 });
  inv = await invoice(co, s1.product, "A5-2");
  // even a wrongly stored policy can't open a batch field
  await prisma.templateField.updateMany({ where: { versionId: s1.versionId, key: "ph_result" }, data: { inferencePolicy: "product_facts_and_web" } });
  const calls = [];
  check = await computeNeeds(inv.id, co.id, { generate: noGaps, inferGenerate: inferModel(calls) });
  n = await needs(inv.id);
  assert("ONE inference call for the invoice", calls.length === 1 && check.ai.inference.calls === 1, check.ai.inference);
  const sent = JSON.parse(calls[0].contents[2].slice(calls[0].contents[2].indexOf("\n") + 1)).map((g) => g.label);
  assert("never-fields never reach the prompt (pH result, batch, registration no.)", !sent.some((l) => /pH result|Batch|Registration/.test(l)) && sent.includes("Storage"), sent);
  assert("quoted: storage from the description, with path + quote", n.storage.status === "inferred" && n.storage.value === "Store below 25 °C in a dry place" && n.storage.provenance.tier === "I" && n.storage.provenance.derivation === "quoted" && n.storage.provenance.evidence[0].path === "product.description", n.storage);
  assert("select_from_list / join_list / unit_conversion / normalize_case — code's own value stored", n.species.value === "Poultry" && n.composition.value === "Vitamin E 120 g/L, Selenium 0.5 g/L" && n.vit_e_mg.value === "120000 mg/l" && n.appearance_caps.value === "LIGHT YELLOW LIQUID", { s: n.species.value, c: n.composition.value, v: n.vit_e_mg.value, a: n.appearance_caps.value });
  assert("free-form reasoning ('probably Amman') → rejected, stays missing", n.address.status === "missing" && check.ai.inference.rejected === 1, n.address.status);
  assert("0 values reach batch / invoice / never fields", n.ph_result.status === "missing" && !n.ph_result.value && n.batch_no.status === "resolved" && n.reg_no.status === "missing");
  const infS = await prisma.aiSuggestion.findMany({ where: { companyId: co.id, kind: "product_infer" } });
  assert("always waiting for a person, even with auto-accept on at 0.5 (§14.4)", infS.length >= 5 && infS.filter((x) => x.evidenceVerified).every((x) => x.status === "pending"), infS.map((x) => x.status));
  assert("inferred values block generation until confirmed", (await blockingCounts(inv.id)).needsConfirmation >= 5);
  const again = [];
  await computeNeeds(inv.id, co.id, { generate: noGaps, inferGenerate: inferModel(again) });
  assert("a second check → 0 inference calls (already asked)", again.length === 0);
  await api("PATCH", "/certificate-ai-settings", A, { allowWebLookup: true });
  await computeNeeds(inv.id, co.id, { generate: noGaps, inferGenerate: inferModel([]) });
  assert("the web is never called by the check, even with web lookup on (only on a person's request)", (await prisma.aiRun.count({ where: { companyId: co.id, kind: "CERT_WEB_LOOKUP" } })) === 0);

  console.log("\n🧪 Tier W — on request, cited, verified, cached (§14.3)");
  await api("PATCH", "/certificate-ai-settings", A, { allowWebLookup: true });
  check = await getView(inv.id);
  assert("the panel is told what the web could still look up", check.tiers.web === true && check.tiers.webEligible === 2, check.tiers);
  const pages = {
    "https://www.addvet.com/vitaplus": goodPage,
    "https://shop.example/vitaplus": { ok: true, finalUrl: "https://shop.example/vitaplus", host: "shop.example", text: "VITAPLUS E (ADDvet) — Registration No. VR-4471 — buy now" },
  };
  const searchCalls = [];
  const search = async (args) => {
    searchCalls.push(args);
    return {
      fields: [
        { label: "Manufacturer address", found: true, value: "12 Industrial Zone, Amman", sourceType: "manufacturer", citations: [{ url: "https://www.addvet.com/vitaplus", title: "VITAPLUS E", quote: "Manufactured by AFAQ at 12 Industrial Zone, Amman" }], confidence: 0.9 },
        { label: "Registration No.", found: true, value: "VR-4471", sourceType: "distributor", citations: [{ url: "https://shop.example/vitaplus", title: "Shop", quote: "Registration No. VR-4471" }], confidence: 0.9 },
      ],
    };
  };
  check = await webLookupNeeds(inv.id, co.id, { search, fetchPage: pageFor(pages) });
  n = await needs(inv.id);
  assert("ONE web call for the product", searchCalls.length === 1 && check.ai.web.calls === 1, check.ai.web);
  const q = JSON.stringify(searchCalls[0].contents);
  assert("the query carries product facts only — no invoice number, customer or price", q.includes("VITAPLUS E") && q.includes("AFAQ") && !q.includes("A5-2") && !q.includes("SECRET CUSTOMER") && !q.includes("999"));
  assert("manufacturer address: web_found, with the citation (url, quote, source type)", n.address.status === "web_found" && n.address.value === "12 Industrial Zone, Amman" && n.address.provenance.tier === "W" && n.address.provenance.citations[0].sourceType === "manufacturer" && n.address.provenance.cacheId, n.address.provenance);
  assert("registration no. from a shop page → rejected (registry only)", n.reg_no.status === "missing" && check.ai.web.rejected === 1);
  const cache = await prisma.externalKnowledgeCache.findMany({ where: { kind: "cert_product_fact", lookupKey: { startsWith: `${co.id}|` } } });
  assert("cached per company (found and not-found), 90 days, unreviewed", cache.length === 2 && cache.every((c) => c.status === "unreviewed" && c.expiresAt > new Date(Date.now() + 80 * 86_400_000)));
  const inv3 = await invoice(co, s1.product, "A5-3");
  await computeNeeds(inv3.id, co.id, { generate: noGaps, inferGenerate: inferModel([]) });
  const again2 = [];
  check = await webLookupNeeds(inv3.id, co.id, { search: async (a) => (again2.push(a), { fields: [] }), fetchPage: pageFor(pages) });
  assert("the same facts on another invoice → 0 web calls, from the cache", again2.length === 0 && check.ai.web.fromCache === 2 && (await needs(inv3.id)).address.status === "web_found" && (await needs(inv3.id)).address.provenance.fromCache === true, check.ai.web);
  const sB = await seedCompany(coB);
  await api("PATCH", "/certificate-ai-settings", B, { allowWebLookup: true });
  const invB = await invoice(coB, sB.product, "B-1");
  await computeNeeds(invB.id, coB.id, { generate: noGaps });
  const bCalls = [];
  await webLookupNeeds(invB.id, coB.id, { search: async (a) => (bCalls.push(a), { fields: [] }), fetchPage: pageFor(pages) });
  assert("another company never gets company A's cached facts (its own call)", bCalls.length === 1);
  let r = await api("POST", `/invoices/${inv.id}/data-needs/web-lookup`, B);
  assert("the web-lookup endpoint is tenant-scoped (404)", r.status === 404, r.status);

  console.log("\n🧪 A person decides; save to product (§14.4)");
  check = await decideNeeds(inv.id, co.id, [{ needId: n.storage.id, action: "accept", saveToProduct: true }]);
  const saved = await prisma.product.findUnique({ where: { id: s1.product.id } });
  n = await needs(inv.id);
  assert("accepted + saved into the product field (storage)", n.storage.status === "resolved_ai" && n.storage.provenance.savedToProduct === "storage" && saved.storage === "Store below 25 °C in a dry place", n.storage);
  assert("… the suggestion records it", (await prisma.aiSuggestion.findUnique({ where: { id: n.storage.suggestionId } })).finalValue.savedToProduct === "storage");
  await decideNeeds(inv.id, co.id, [{ needId: n.address.id, action: "accept" }]);
  assert("accepting a web fact approves its cache entry", (await prisma.externalKnowledgeCache.findUnique({ where: { id: n.address.provenance.cacheId } })).status === "approved");
  const w = resolveWithNeed({ key: "address", source: FIELDS[5].source }, {}, await prisma.certificateDataNeed.findUnique({ where: { id: n.address.id } }));
  assert("generation keeps the tier, the citation and who confirmed it", w.origin === "data_check" && w.provenance.tier === "W" && w.provenance.citations[0].quote && "confirmedByUserId" in w.provenance && w.provenance.confirmedAt, w.provenance);
  const err = await decideNeeds(inv.id, co.id, [{ needId: n.ph_result.id, action: "accept", saveToProduct: true }]).catch((e) => e);
  assert("save-to-product only for a tier I/W value", err?.statusCode === 409);
  await decideNeeds(inv3.id, co.id, [{ needId: (await needs(inv3.id)).address.id, action: "reject" }]);
  assert("rejecting a web fact rejects its cache entry (not served again)", (await prisma.externalKnowledgeCache.findUnique({ where: { id: n.address.provenance.cacheId } })).status === "rejected");
  const inv4 = await invoice(co, s1.product, "A5-4");
  const after = [];
  await computeNeeds(inv4.id, co.id, { generate: noGaps, inferGenerate: inferModel(after) });
  const n4 = await needs(inv4.id);
  assert("next invoice: the saved fact is read by code (resolved), not asked again", n4.storage.status === "resolved" && !JSON.parse(after[0].contents[2].slice(after[0].contents[2].indexOf("\n") + 1)).some((g) => g.label === "Storage"), n4.storage.status);

  console.log("\n🧪 API");
  r = await api("PATCH", "/certificate-ai-settings", A, { webDomainAllowList: ["https://www.Vetblog.example/x", "not a domain"] });
  assert("allow-list validated", r.status === 400 && /not a domain/.test(r.data.message), r.data);
  r = await api("PATCH", "/certificate-ai-settings", A, { webDomainAllowList: ["https://www.Vetblog.example/x"] });
  assert("… stored as a bare domain", r.status === 200 && r.data.data.settings.webDomainAllowList.join() === "vetblog.example", r.data);
  r = await api("GET", "/certificate-ai-settings", B);
  assert("company B (pinned confirm-first) keeps inference off and its own empty allow-list", r.data.data.settings.allowProductInference === false && r.data.data.settings.webDomainAllowList.length === 0);
  r = await api("GET", `/invoices/${inv.id}/data-needs`, A);
  assert("the view reports the tiers and counts", r.status === 200 && "inferred" in r.data.data.check.summary && "webFound" in r.data.data.check.summary && r.data.data.check.tiers, r.data?.data?.check?.summary);
} finally {
  await finish(counts, async () => {
    await prisma.externalKnowledgeCache.deleteMany({ where: { kind: "cert_product_fact", OR: [{ lookupKey: { startsWith: `${co.id}|` } }, { lookupKey: { startsWith: `${coB.id}|` } }] } });
    for (const c of [co.id, coB.id]) await cleanupCompany(c);
  });
}

async function getView(invoiceId) {
  const { getNeeds } = await import("../../src/services/certificates/dataNeeds/dataNeedsService.js");
  return getNeeds(invoiceId, co.id);
}
