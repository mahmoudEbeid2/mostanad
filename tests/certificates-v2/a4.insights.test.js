// Certificate AI layers — Phase A4 (plan.md §9): dictionary health + AI label
// synonyms, template-driven product completeness, structured product data
// entry, and the evaluation dashboard. The model is a stand-in.
// Proven here:
//  - health: low coverage, conflicting types, near-duplicate keys (→ a person's path synonym), spelling variants
//  - AI synonyms: ONE call for keys never asked, only given paths kept, ALWAYS pending (even with
//    auto-accept on), accept/edit/reject by a person, AI off → no call; never cross-tenant
//  - completeness: per need (which templates, how many products) and per product; synonyms count
//  - structured entry: only the needed paths are written, other keys kept, an existing key's
//    spelling kept, list rows merged by key (extra keys survive), tenancy
//  - stats: acceptance/edit rates, calibration, calls per template / invoice per week, cost estimate
// Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { suggestSynonyms } from "../../src/services/certificates/insights/dictionaryHealth.js";
import { looksDuplicate } from "../../src/services/certificates/insights/dictionaryHealth.js";
import { costUsd } from "../../src/services/certificates/insights/aiStats.js";
import { buildDictionary } from "../../src/services/certificates/dictionary/dataDictionary.js";

const { assert, counts } = makeAssert();
const co = await createCompany("a4a");
const coB = await createCompany("a4b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

const mk = (data) => prisma.product.create({ data: { companyId: co.id, ...data } });
try {
  const p1 = await mk({ name: "ADD-E120", withdrawalPeriod: "Zero days", specifications: { type: "string", values: { pH: "3.0-5.0", Assay: "95", "Assay %": "90-110%" } }, activeIngredients: [{ name: "Vitamin E", concentration: "120 g" }, { name: "Sodium selenite", concentration: "60 mg", note: "keep me" }] });
  const p2 = await mk({ name: "DOXYPHARMA", specifications: { values: { PH: "2.0 – 3.0", Assay: 98 } }, activeIngredients: [{ name: "Doxycycline", concentration: "500 mg" }] });
  const p3 = await mk({ name: "ADD-COMPLEX", withdrawalPeriod: "None", specifications: { values: { "PH value": "5.5-6.5", ws_period: "5 d" } } });
  const p4 = await mk({ name: "TYLOPHARMA", specifications: null, activeIngredients: [{ Name: "Tylosin", concentration: "200 mg" }] });
  await prisma.product.create({ data: { companyId: coB.id, name: "B-SECRET", specifications: { values: { secret_b_key: "x" } } } });
  await buildDictionary(co.id);
  const coa = await seedTemplate(co.id, {
    name: "COA",
    typeCode: "COA",
    typeName: "Certificate of Analysis",
    scope: "per_product",
    fields: [
      { key: "ph_spec", label: "pH specification", source: { kind: "product", path: "specifications.values.pH" } },
      { key: "withdrawal", label: "Withdrawal period", source: { kind: "product", path: "withdrawalPeriod" } },
      { key: "selenite", label: "Sodium selenite amount", source: { kind: "product", path: 'activeIngredients[name="Sodium selenite"].concentration' } },
      { key: "category", label: "Category", source: { kind: "product", path: "category.name" } },
      { key: "pname", label: "Product name", source: { kind: "product", path: "name" } },
      { key: "batch", label: "Batch", source: { kind: "item", path: "batchNo" } },
    ],
  });
  const hc = await seedTemplate(co.id, { name: "HC", typeCode: "HC", typeName: "Health Certificate", scope: "per_product", fields: [{ key: "ph", label: "pH", source: { kind: "template", template: "pH {{product.specifications.values.pH}}" } }, { key: "c_name", label: "Constituent", source: { kind: "row", path: "name" } }] });
  await prisma.templateField.updateMany({ where: { versionId: hc.versionId, key: "c_name" }, data: { groupKey: "constituents" } });
  await prisma.templateGroup.create({ data: { versionId: hc.versionId, key: "constituents", label: "Constituents", source: { kind: "product_list", path: "activeIngredients" } } });

  console.log("\n🧪 Dictionary health (§9)");
  assert("near-duplicate rules", looksDuplicate("Assay", "Assay %") && looksDuplicate("pH", "PH value") && looksDuplicate("Withdrawl", "Withdrawal") && !looksDuplicate("Density", "Appearance") && !looksDuplicate("pH", "Assay"));
  let r = await api("GET", "/certificate-data-dictionary/health", A);
  const h = r.data?.data?.health;
  assert("health → 200", r.status === 200, r.data);
  assert("variants: pH / PH grouped by code (info)", h.variants.some((v) => v.spellings.includes("pH") && v.spellings.includes("PH")), h.variants);
  assert("type conflict: Assay is a number in one product and text in another", h.typeConflicts.some((t) => t.path === "product.specifications.values.Assay" && t.types.number === 1 && t.types.string === 1), h.typeConflicts);
  const dupPh = h.nearDuplicates.find((d) => d.alternative.path === 'product.specifications.values["PH value"]');
  assert("near duplicates: Assay ~ Assay %, pH ~ PH value (canonical = the more common one)", h.nearDuplicates.some((d) => [d.canonical.path, d.alternative.path].includes('product.specifications.values["Assay %"]')) && dupPh?.canonical.path === "product.specifications.values.pH", h.nearDuplicates);
  assert("low coverage keys listed, with whether a template needs them", h.lowCoverage.length === 0 || h.lowCoverage.every((x) => typeof x.neededByTemplates === "boolean"));
  assert("no other company's key in the report", !JSON.stringify(h).includes("secret_b_key"));
  r = await api("POST", "/certificate-data-dictionary/synonyms", A, dupPh.action);
  r = await api("GET", "/certificate-data-dictionary/health", A);
  assert("the suggested merge, once a person adds it → alreadySynonym, listed under pathSynonyms", r.data.data.health.nearDuplicates.find((d) => d.alternative.path === dupPh.alternative.path)?.alreadySynonym === true && r.data.data.health.pathSynonyms.length === 1);
  assert("products were not touched by any of it", JSON.stringify((await prisma.product.findUnique({ where: { id: p3.id } })).specifications) === JSON.stringify(p3.specifications));

  console.log("\n🧪 AI label synonyms (CERT_DICTIONARY, §3.2 / §12 Q3)");
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: true, autoAcceptThreshold: 0.5 });
  const calls = [];
  const stub = async (args) => {
    calls.push(args);
    return { keys: [{ path: "product.specifications.values.ws_period", label: "Withdrawal period", synonyms: ["WP", "withdrawal time"], confidence: 0.95, rationale: "ws = withdrawal" }, { path: "product.invented.key", label: "Made up", confidence: 1 }, { path: "product.specifications.values.secret_b_key", label: "B", confidence: 1 }] };
  };
  let out = await suggestSynonyms(co.id, { generate: stub });
  assert("ONE call; only keys of this company's dictionary sent", calls.length === 1 && !JSON.stringify(calls[0].contents).includes("secret_b_key") && JSON.stringify(calls[0].contents).includes("ws_period"));
  assert("only paths it was given are kept (invented / foreign dropped)", out.suggested === 1, out);
  const pend = await prisma.aiSuggestion.findMany({ where: { companyId: co.id, kind: "dictionary_synonym" } });
  assert("pending even with auto-accept on at 0.5 — a person decides each", pend.length === 1 && pend[0].status === "pending" && pend[0].entityType === "dictionary_entry", pend.map((s) => s.status));
  out = await suggestSynonyms(co.id, { generate: stub });
  assert("asked keys are not asked again (the rest are)", calls.length === 2 && !calls[1].contents[1].includes("ws_period"));
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: false, allowSynonyms: false });
  out = await suggestSynonyms(co.id, { generate: stub });
  assert("allowSynonyms off → no call, reason", calls.length === 2 && out.ai.unavailable && /turned off/.test(out.ai.reason));
  await api("PATCH", "/certificate-ai-settings", A, { allowSynonyms: true });
  r = await api("GET", "/certificate-data-dictionary/health", A);
  assert("pending suggestion shown in the health report", r.data.data.health.synonymSuggestions.some((s) => s.label === "Withdrawal period"));
  r = await api("POST", `/certificate-data-dictionary/synonym-suggestions/${pend[0].id}`, B, { decision: "accept" });
  assert("another company → 404", r.status === 404, r.status);
  r = await api("POST", `/certificate-data-dictionary/synonym-suggestions/${pend[0].id}`, A, { decision: "accept", synonyms: ["Withdrawal period", "WP"] });
  assert("accept (edited) → label synonyms on the entry; suggestion edited", r.status === 200 && r.data.data.status === "edited" && r.data.data.synonyms.includes("Withdrawal period"), r.data);
  const entry = (await prisma.dataDictionary.findUnique({ where: { companyId: co.id } })).entries.find((e) => e.path === "product.specifications.values.ws_period");
  assert("… stored on the dictionary entry (A1 mapping matches it)", entry.synonyms.includes("WP"));
  r = await api("POST", `/certificate-data-dictionary/synonym-suggestions/${pend[0].id}`, A, { decision: "reject" });
  assert("already decided → 409", r.status === 409, r.status);
  await buildDictionary(co.id);
  assert("accepted synonyms survive a rebuild", (await prisma.dataDictionary.findUnique({ where: { companyId: co.id } })).entries.find((e) => e.path === "product.specifications.values.ws_period").synonyms.includes("WP"));

  console.log("\n🧪 Completeness (§9)");
  r = await api("GET", "/certificate-product-completeness", A);
  const c = r.data?.data?.completeness;
  assert("→ 200, 4 products", r.status === 200 && c.totals.products === 4, r.data);
  const phNeed = c.needs.find((n) => n.path === "product.specifications.values.pH");
  assert("pH spec needed by 2 templates (field + combination); missing only on TYLOPHARMA (PH and PH value count)", phNeed.templates.sort().join() === "COA,HC" && phNeed.missingCount === 1 && phNeed.missing[0].name === "TYLOPHARMA", phNeed);
  const wd = c.needs.find((n) => n.path === "product.withdrawalPeriod");
  assert("withdrawal period missing on 2 products", wd.missingCount === 2 && wd.missing.map((m) => m.name).sort().join() === "DOXYPHARMA,TYLOPHARMA", wd);
  const list = c.needs.find((n) => n.kind === "list");
  assert("the constituents list: Sodium selenite amount + the group's rows", list.path === "product.activeIngredients" && list.expected.includes("Sodium selenite") && list.templates.sort().join() === "COA,HC" && list.missingCount === 3, list);
  assert("relations (category), identity (name) and invoice sources are not product data entry", !c.needs.some((n) => /category|batch/i.test(n.path) || n.path === "product.name"));
  assert("per product: TYLOPHARMA lists what it misses", c.products.find((p) => p.name === "TYLOPHARMA")?.missing.length >= 3 && !c.products.some((p) => p.name === "ADD-E120"), c.products);
  r = await api("GET", "/certificate-product-completeness", B);
  assert("another company sees only its own (no templates → no needs)", r.data.data.completeness.needs.length === 0 && r.data.data.completeness.totals.products === 1);

  console.log("\n🧪 Structured product data entry (§9)");
  r = await api("GET", `/certificate-products/${p4.id}/data`, A);
  const d = r.data?.data;
  assert("definition: fixed inputs for pH spec + withdrawal; a constituents list (name + concentration)", r.status === 200 && d.definition.fields.map((f) => f.path).sort().join() === "specifications.values.pH,withdrawalPeriod" && d.definition.lists[0].path === "activeIngredients" && d.definition.lists[0].children.join() === "name,concentration", d?.definition);
  assert("current values and what this product misses", d.values["specifications.values.pH"] === "" && d.lists.activeIngredients[0].name === "Tylosin" && d.missing.length >= 3, d);
  r = await api("PATCH", `/certificate-products/${p4.id}/data`, A, { values: { "specifications.values.pH": "6.0-7.0", withdrawalPeriod: "Meat: 5 days" }, lists: { activeIngredients: [{ name: "Tylosin", concentration: "200 mg" }, { name: "Sodium selenite", concentration: "1 mg" }] } });
  let saved = await prisma.product.findUnique({ where: { id: p4.id } });
  assert("written: JSON created where there was none, column set", r.status === 200 && saved.specifications.values.pH === "6.0-7.0" && saved.withdrawalPeriod === "Meat: 5 days", r.data);
  assert("list merged by key: TYLOPHARMA's own 'Name' spelling kept, new row added", saved.activeIngredients[0].Name === "Tylosin" && !("name" in saved.activeIngredients[0]) && saved.activeIngredients[1].name === "Sodium selenite", saved.activeIngredients);
  assert("the product is now complete", r.data.data.missing.length === 0, r.data.data.missing);
  r = await api("PATCH", `/certificate-products/${p2.id}/data`, A, { values: { "specifications.values.pH": "2.5-3.5" } });
  saved = await prisma.product.findUnique({ where: { id: p2.id } });
  assert("an existing spelling is kept: DOXYPHARMA's 'PH' updated, no second 'pH' key; other keys untouched", saved.specifications.values.PH === "2.5-3.5" && !("pH" in saved.specifications.values) && saved.specifications.values.Assay === 98, saved.specifications);
  r = await api("PATCH", `/certificate-products/${p1.id}/data`, A, { lists: { activeIngredients: [{ name: "Sodium selenite", concentration: "65 mg" }, { name: "Vitamin E", concentration: "120 g" }] } });
  saved = await prisma.product.findUnique({ where: { id: p1.id } });
  assert("an element's extra keys survive the list edit", saved.activeIngredients[0].note === "keep me" && saved.activeIngredients[0].concentration === "65 mg" && saved.specifications.type === "string", saved.activeIngredients);
  r = await api("PATCH", `/certificate-products/${p1.id}/data`, A, { values: { "specifications.values.Density": "1" } });
  assert("a path no active template needs → 400 (never free-form writes)", r.status === 400 && r.data.code === "NOT_A_CERTIFICATE_FIELD", r.data);
  r = await api("PATCH", `/certificate-products/${p1.id}/data`, A, { values: { withdrawalPeriod: null } });
  assert("clearing a value", r.status === 200 && (await prisma.product.findUnique({ where: { id: p1.id } })).withdrawalPeriod === null);
  r = await api("GET", `/certificate-products/${p1.id}/data`, B);
  assert("another company's product → 404 (read)", r.status === 404, r.status);
  r = await api("PATCH", `/certificate-products/${p1.id}/data`, B, { values: { withdrawalPeriod: "x" } });
  assert("… and write", r.status === 404 && (await prisma.product.findUnique({ where: { id: p1.id } })).withdrawalPeriod === null, r.status);
  r = await api("GET", "/certificate-product-completeness", A);
  assert("completeness follows the edits", r.data.data.completeness.needs.find((n) => n.path === "product.specifications.values.pH").missingCount === 0);

  console.log("\n🧪 Evaluation dashboard (§9)");
  const mkS = (kind, status, confidence, decided = true) => prisma.aiSuggestion.create({ data: { companyId: co.id, kind, entityType: "template_field", entityId: "x", proposal: {}, confidence, status, modelId: "m", promptHash: "p", inputHash: "i", decidedByUserId: decided && ["accepted", "edited", "rejected"].includes(status) ? "u1" : null } });
  await prisma.aiSuggestion.deleteMany({ where: { companyId: co.id } });
  await Promise.all([mkS("field_map", "accepted", 0.95), mkS("field_map", "accepted", 0.92), mkS("field_map", "edited", 0.6), mkS("field_map", "rejected", 0.3, false), mkS("field_map", "pending", 0.8), mkS("invoice_gap", "auto_accepted", 0.97)]);
  await prisma.aiRun.deleteMany({ where: { companyId: co.id } });
  const run = (kind, entityId, daysAgo, tokens = {}) => prisma.aiRun.create({ data: { companyId: co.id, kind, entityType: "x", entityId, modelId: "m", promptHash: "p", outcome: "ok", calls: 1, inputTokens: 1000, outputTokens: 100, thinkingTokens: 50, cachedTokens: 200, ms: 1200, createdAt: new Date(Date.now() - daysAgo * 86_400_000), ...tokens } });
  await Promise.all([run("CERT_FIELD_MAP", "t1", 14), run("CERT_FIELD_MAP", "t2", 14), run("CERT_FIELD_MAP", "t3", 0), run("CERT_INVOICE_GAPS", "i1", 0), run("INVOICE_EXTRACT", "i1", 0), run("CERT_PRODUCT_MATCH", "i1", 0)]);
  await prisma.aiRun.create({ data: { companyId: co.id, kind: "CERT_FIELD_MAP", modelId: "m", promptHash: "p", outcome: "disabled" } });
  await prisma.aiRun.create({ data: { companyId: coB.id, kind: "CERT_FIELD_MAP", modelId: "m", promptHash: "p", outcome: "ok", inputTokens: 999999 } });
  r = await api("GET", "/certificate-ai-stats?days=90", A);
  const s = r.data?.data?.stats;
  const fm = s?.kinds.find((k) => k.kind === "field_map");
  assert("stats → 200; field_map: 5 total, acceptance 2/4, edit 1/4, refused by code 1", r.status === 200 && fm.total === 5 && fm.acceptanceRate === 0.5 && fm.editRate === 0.25 && fm.refusedByCode === 1 && fm.pending === 1, fm);
  const top = s.calibration.find((b) => b.bucket === "≥ 0.90");
  assert("calibration: ≥ 0.90 bucket 3/3 kept (incl. auto-accepted); < 0.50 0/1", top.decided === 3 && top.correctRate === 1 && s.calibration.find((b) => b.bucket === "< 0.50").correctRate === 0, s.calibration);
  const fmRuns = s.runs.find((k) => k.kind === "CERT_FIELD_MAP");
  assert("runs per kind: calls exclude disabled; tokens summed", fmRuns.calls === 3 && fmRuns.disabled === 1 && fmRuns.inputTokens === 3000, fmRuns);
  const each = costUsd({ inputTokens: 1000, outputTokens: 100, thinkingTokens: 50, cachedTokens: 200 });
  assert("cost estimate = (800×0.30 + 200×0.075 + 150×2.50) / 1M per call", Math.abs(each - (800 * 0.3 + 200 * 0.075 + 150 * 2.5) / 1e6) < 1e-12 && Math.abs(s.cost.totalUsd - each * 6) < 1e-6 && s.cost.estimate === true, s.cost);
  const tWeeks = s.weekly.filter((w) => w.per === "template");
  assert("calls per template per week (2 weeks)", tWeeks.length === 2 && tWeeks.every((w) => w.callsPerEntity === 1), s.weekly);
  const inv = s.weekly.find((w) => w.per === "invoice");
  assert("calls per invoice: extraction + gaps + matching for one invoice = 3", inv.calls === 3 && inv.entities === 1 && inv.callsPerEntity === 3, inv);
  assert("another company's runs are not counted", !s.runs.some((k) => k.inputTokens >= 999999));
  r = await api("GET", "/certificate-ai-stats", B);
  assert("company B sees its own stats only", r.status === 200 && r.data.data.stats.runs.length === 1 && r.data.data.stats.kinds.length === 0);
} finally {
  await finish(counts, async () => {
    for (const c2 of [co.id, coB.id]) await cleanupCompany(c2);
  });
}
