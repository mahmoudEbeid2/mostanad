// Certificate AI layers — Phase A1 template field mapping (plan.md §5, §5.4).
// The model is a deterministic stand-in (npm test never calls a paid API);
// the live accuracy run is scripts/evalCertMapping.js (RUN_LIVE_GEMINI=1).
// Proven here:
//  - label proposals (code) on both goldens: same line, column header, row label
//  - the chain: memory → dictionary → ONE AI call per template; ≥ 90 % exact,
//    100 % batch_data, 0 invalid paths — with a correct model; what code alone resolves
//  - AI off (company setting) / AI down (Gemini disabled) → code still maps, the rest is the user's (P8)
//  - adversarial answers refused: invented path, fabricated text, invented placeholder, errors (P1, P5)
//  - the prompt carries only the caller's company data (P6); suggestions carry provenance (P7)
//  - pending AI mappings block activation until confirmed; an edit is recorded; activation remembers;
//    a second template with the same labels needs 0 AI calls
//  - repeating-group binding (code with a sample product; AI answer validated)
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import { api, asCompany, asAdmin, makeAssert, finish, createCompany, cleanupCompany, pollTask, prisma } from "./helpers.js";
import { seedMappingCompany, uploadGolden, wizardFields, runGolden, goldenModel, score } from "./mappingHarness.js";
import { mapFields } from "../../src/services/certificates/mapping/fieldMapper.js";
import { closeQueues } from "../../src/services/certificates/jobs/queues.js";

const { assert, counts } = makeAssert();
const { company, products, typeId } = await seedMappingCompany("a1a");
const coB = await createCompany("a1b");
const A = asCompany(company.id);
const B = asCompany(coB.id);
const ADD = "ADDVET_COA.ai";
const PHA = "PHARMAVET_COA.pdf";
const answer = (key, a) => ({ key, category: "product_data", confidence: 0.8, rationale: "stub", ...a });
const stub = (fn, calls = []) => async (args) => {
  calls.push(args);
  const part = args.contents[args.contents.length - 1];
  return fn(JSON.parse(part.slice(part.indexOf("\n") + 1)), args);
};

try {
  await prisma.product.create({ data: { companyId: coB.id, name: "B-SECRET-PRODUCT", specifications: { values: { secretKeyB: "b-secret" } } } });
  const addvet = await uploadGolden(company.id, typeId, ADD);
  const pharma = await uploadGolden(company.id, typeId, PHA, "TR");
  assert("both goldens converted to draft", addvet?.status === "draft" && pharma?.status === "draft");

  console.log("\n🧪 Label proposals (code, §5.1 step 2)");
  const addFields = await wizardFields(company.id, addvet, ADD);
  const pFields = await wizardFields(company.id, pharma, PHA);
  const proposed = (fs) => Object.fromEntries(fs.map((f) => [f.key, f.proposedLabel]));
  const pa = proposed(addFields);
  assert("ADDVET same line: Batch No. / Product Name / Expiry Date / Production Date", pa.batch_no === "Batch No." && pa.product_name === "Product Name" && pa.expiry === "Expiry Date" && pa.production === "Production Date", pa);
  assert("ADDVET table row: “pH result”", pa.ph_result === "pH result", pa.ph_result);
  assert("ADDVET constituent name (the value is the row label) → none, the user/AI names it", pa.constituent_2_name === null, pa.constituent_2_name);
  const pp = proposed(pFields);
  assert("PHARMAVET column headers: Expiration date / Manufacturing date / Batch number", pp.expiry === "Expiration date" && pp.production === "Manufacturing date" && pp.batch_no === "Batch number", pp);
  assert("PHARMAVET row labels: pH result / Producer", pp.ph_result === "pH result" && pp.producer === "Producer", pp);
  let r = await api("POST", `/template-versions/${addvet.id}/label-proposals`, A, { fields: [{ lineId: "p1-l11", charStart: 12, charEnd: 23, sampleValue: "AVVS1122005" }] });
  assert("API → key slug + category", r.status === 200 && r.data.data.proposals[0].key === "batch_no" && r.data.data.proposals[0].category === null, r.data);
  const phProbe = addFields.find((f) => f.key === "ph_result");
  r = await api("POST", `/template-versions/${addvet.id}/label-proposals`, A, { fields: [{ lineId: phProbe.lineId, charStart: phProbe.charStart, charEnd: phProbe.charEnd, sampleValue: phProbe.sampleValue }] });
  assert("pH result → category batch_data", r.data?.data?.proposals?.[0]?.category === "batch_data");
  r = await api("POST", `/template-versions/${addvet.id}/label-proposals`, A, { fields: [{ lineId: "p1-l11", charStart: 0, charEnd: 5, sampleValue: "WRONG" }] });
  assert("offsets that don't hold the sample → 422", r.status === 422, r.status);
  r = await api("POST", `/template-versions/${addvet.id}/label-proposals`, B, { fields: [{ lineId: "p1-l11", charStart: 12, charEnd: 23, sampleValue: "AVVS1122005" }] });
  assert("another tenant's version → 404", r.status === 404, r.status);

  console.log("\n🧪 AI off for the company → code still maps (P8)");
  await api("PATCH", "/certificate-ai-settings", A, { enabled: false });
  r = await api("POST", `/template-versions/${addvet.id}/map-fields`, A, { fields: addFields });
  let m = r.data?.data?.mappings || {};
  assert("map-fields → 200", r.status === 200, r.data);
  assert("memory/dictionary/layout fields mapped (batch, name, dates, pH)", ["batch_no", "product_name", "expiry", "production", "ph_result"].every((k) => m[k]?.status === "accepted"), m);
  assert("the rest left to the user, saying why", ["constituent_2_name", "constituent_2_amount", "document_no"].every((k) => m[k]?.status === "unmapped" && /turned off/.test(m[k].rationale)), m.document_no);
  assert("no AI call; recorded as disabled", r.data.data.ai.calls === 0 && (await prisma.aiRun.count({ where: { companyId: company.id, kind: "CERT_FIELD_MAP", outcome: "disabled" } })) === 1);
  await api("PATCH", "/certificate-ai-settings", A, { enabled: true });

  console.log("\n🧪 AI unavailable (Gemini disabled in tests) → code still maps (P8)");
  r = await api("POST", `/template-versions/${addvet.id}/map-fields`, A, { fields: addFields, sampleProductId: products["ADD-E120"].id });
  m = r.data?.data?.mappings || {};
  assert("200, ai.unavailable with a user-facing reason (no env flags or model ids)", r.status === 200 && r.data.data.ai.unavailable === true && /switched off/.test(r.data.data.ai.reason) && !/GEMINI|gemini-/.test(r.data.data.ai.reason), r.data?.data?.ai);
  assert("code mappings still returned", m.batch_no?.source?.path === "batchNo" && m.product_name?.confidence === 0.98, m.product_name);
  assert("the failed call is in ai_runs", (await prisma.aiRun.count({ where: { companyId: company.id, kind: "CERT_FIELD_MAP", outcome: "failed" } })) === 1);

  console.log("\n🧪 Golden mapping sets (§5.4) with a correct stand-in model");
  for (const [file, version, sample] of [[ADD, addvet, "ADD-E120"], [PHA, pharma, "DOXYPHARMA"]]) {
    const calls = [];
    const g = await runGolden(company.id, version, file, { generate: goldenModel(file, { calls }), sampleProductId: products[sample].id });
    const s = g.score;
    assert(`${file}: ≥ 90 % exact source (${s.exact}/${s.total})`, s.exact / s.total >= 0.9, s.perField.filter((x) => !x.ok));
    assert(`${file}: 100 % of batch_data fields (${s.batchCorrect}/${s.batchTotal})`, s.batchCorrect === s.batchTotal && s.batchTotal === 1);
    assert(`${file}: 0 invalid paths`, s.invalid === 0);
    assert(`${file}: exactly one AI call for the whole template`, calls.length === 1 && g.out.ai.calls === 1);
    const byCode = s.perField.filter((x) => ["dictionary", "memory"].includes(x.origin)).length;
    assert(`${file}: code alone resolved ${byCode}/${s.total} (no AI for those)`, byCode === (file === ADD ? 5 : 5), s.perField.map((x) => `${x.key}:${x.origin}`));
    const sent = JSON.parse(calls[0].contents[3].slice(calls[0].contents[3].indexOf("\n") + 1)).fields.map((f) => f.key);
    assert(`${file}: only the unresolved fields were sent`, sent.every((k) => s.perField.find((x) => x.key === k).origin === "ai"), sent);
    assert(`${file}: AI mappings are pending (auto-accept off by default)`, s.perField.filter((x) => x.origin === "ai").every((x) => x.status === "pending"));
  }
  const sugg = await prisma.aiSuggestion.findMany({ where: { companyId: company.id, kind: "field_map", status: "pending" } });
  assert("one AiSuggestion per AI answer, with provenance (P7)", sugg.length === 4 && sugg.every((x) => x.modelId && x.promptHash && x.inputHash && x.dictionaryVersion >= 1 && x.aiRunId), sugg.length);
  assert("plausibility vs the sample product raised the element paths (≥ 0.97, evidence)", sugg.filter((x) => x.entityId.endsWith(":constituent_2_amount") || x.entityId.endsWith(":constituent_amount")).every((x) => x.confidence >= 0.97 && x.evidence?.[0]?.type === "sample_product"));
  const okRuns = await prisma.aiRun.findMany({ where: { companyId: company.id, kind: "CERT_FIELD_MAP", outcome: "ok" } });
  assert("ai_runs: one ok row per template, with a reason", okRuns.length === 2 && okRuns.every((x) => /not resolved by memory or dictionary/.test(x.reason)));

  console.log("\n🧪 Plausibility penalty + auto-accept (P4)");
  let g = await runGolden(company.id, pharma, PHA, { generate: goldenModel(PHA, { confidence: 0.95 }), sampleProductId: products["TYLOPHARMA"].id });
  assert("sample product disagrees → confidence × 0.6, with the reason", g.out.mappings.constituent_amount.confidence === 0.57 && /sample product/.test(g.out.mappings.constituent_amount.evidence?.text), g.out.mappings.constituent_amount);
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: true, autoAcceptThreshold: 0.9 });
  g = await runGolden(company.id, pharma, PHA, { generate: goldenModel(PHA, { confidence: 0.95 }) });
  assert("auto-accept on, 0.95 ≥ 0.90 → auto_accepted", g.out.mappings.constituent_amount.status === "auto_accepted", g.out.mappings.constituent_amount);
  g = await runGolden(company.id, pharma, PHA, { generate: goldenModel(PHA, { confidence: 0.95 }), sampleProductId: products["TYLOPHARMA"].id });
  assert("… but not when the sample product contradicts it (0.57)", g.out.mappings.constituent_amount.status === "pending");
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: false });

  console.log("\n🧪 Adversarial model answers (P1, P5)");
  const pAnswer = (a) => stub((p) => ({ fields: p.fields.map((f) => answer(f.key, f.key === "constituent_amount" ? a : { sourceKind: "manual" })) }));
  const run = (gen) => mapFields(pharma.id, company.id, { fields: pFields }, { generate: gen });
  let o = await run(pAnswer({ sourceKind: "product", path: "product.potency" }));
  assert("an invented path → refused, field left manual", o.mappings.constituent_amount.status === "invalid" && o.mappings.constituent_amount.source.kind === "manual", o.mappings.constituent_amount);
  const rejected = await prisma.aiSuggestion.findUnique({ where: { id: o.mappings.constituent_amount.suggestionId } });
  assert("… its suggestion is stored as rejected with the reason", rejected.status === "rejected" && /dictionary/.test(rejected.finalValue.reason));
  o = await run(pAnswer({ sourceKind: "static", text: "750 mg" }));
  assert("fabricated fixed text → refused", o.mappings.constituent_amount.status === "invalid");
  o = await run(pAnswer({ sourceKind: "template", template: "{{product.secretPotency}} mg" }));
  assert("a combination with an invented placeholder → refused", o.mappings.constituent_amount.status === "invalid");
  o = await run(stub((p) => ({ fields: [...p.fields.map((f) => answer(f.key, { sourceKind: "manual" })), answer("producer", { sourceKind: "static", text: "HIJACK" })] })));
  assert("an answer for a field it wasn't asked about is ignored", o.mappings.producer.origin === "dictionary" && o.mappings.producer.source.path === "producer");
  o = await run(async () => {
    throw new Error("Gemini quota exhausted (daily/project limit, not per-minute) for gemini-2.5-flash");
  });
  assert("quota error → ai.unavailable (said as a sentence), code mappings kept, nothing thrown", o.ai.unavailable && /usage limit/.test(o.ai.reason) && !/gemini/i.test(o.ai.reason) && o.mappings.expiry.origin === "dictionary" && o.mappings.constituent_amount.status === "unmapped");
  o = await run(async () => {
    throw new Error("Gemini API call failed for gemini-2.5-flash after 5 attempts (last status 503): timeout");
  });
  assert("timeout/outage → same (\"busy\", no status codes)", o.ai.unavailable && /busy/.test(o.ai.reason) && !/503/.test(o.ai.reason));
  o = await run(stub(() => ({ fields: [] })));
  assert("no answer for a field → unmapped, not invented", o.mappings.constituent_amount.status === "unmapped");

  console.log("\n🧪 Tenant isolation of the prompt (P6)");
  const seen = [];
  await mapFields(addvet.id, company.id, { fields: addFields }, { generate: stub((p) => ({ fields: p.fields.map((f) => answer(f.key, { sourceKind: "manual" })) }), seen) });
  const sentText = JSON.stringify(seen[0].contents);
  assert("the prompt holds this company's products…", sentText.includes("ADD-E120") && sentText.includes("Sodium selenite"));
  assert("…and nothing of company B", !sentText.includes("B-SECRET-PRODUCT") && !sentText.includes("secretKeyB") && !sentText.includes("b-secret"));
  assert("prompt order: instructions → dictionary → product samples → fields", /^You map/.test(seen[0].contents[0]) && seen[0].contents[1].startsWith("Dictionary:") && seen[0].contents[2].startsWith("Product samples:") && seen[0].contents[3].startsWith("Fields:"));
  let threw = null;
  try {
    await mapFields(addvet.id, coB.id, { fields: addFields }, { generate: stub(() => ({ fields: [] })) });
  } catch (err) {
    threw = err;
  }
  assert("mapping another company's version → 404", threw?.statusCode === 404);
  threw = null;
  try {
    await mapFields(addvet.id, company.id, { fields: addFields, sampleProductId: (await prisma.product.findFirst({ where: { companyId: coB.id } })).id }, { generate: stub(() => ({ fields: [] })) });
  } catch (err) {
    threw = err;
  }
  assert("another company's product as the sample → 404", threw?.statusCode === 404);

  console.log("\n🧪 Repeating-group binding (§5.3)");
  const cell = (key, sampleValue) => ({ key, label: key, lineId: "p1-l23", sampleValue, groupKey: "constituents" });
  const groupInput = { fields: [cell("ing_name", "Sodium selenite"), cell("ing_amount", "60 mg")], groups: [{ key: "constituents", label: "Constituents" }] };
  const noModel = stub(() => {
    throw new Error("must not be called");
  });
  o = await mapFields(addvet.id, company.id, { ...groupInput, sampleProductId: products["ADD-E120"].id }, { generate: noModel });
  assert("with a sample product, code binds the list (no AI)", JSON.stringify(o.groups.constituents?.source) === JSON.stringify({ kind: "product_list", path: "activeIngredients" }) && o.groups.constituents.cells.ing_name.path === "name" && o.groups.constituents.cells.ing_amount.path === "concentration" && o.ai.calls === 0, o.groups);
  o = await mapFields(addvet.id, company.id, groupInput, { generate: stub(() => ({ fields: [], groups: [{ key: "constituents", collectionPath: "product.activeIngredients[]", cells: [{ key: "ing_name", childPath: "name" }, { key: "ing_amount", childPath: "concentration" }], confidence: 0.9, rationale: "rows are ingredients" }] })) });
  assert("without one, the AI's binding is validated and used", o.groups.constituents?.origin === "ai" && o.groups.constituents.source.path === "activeIngredients" && o.groups.constituents.status === "pending", o.groups);
  o = await mapFields(addvet.id, company.id, groupInput, { generate: stub(() => ({ fields: [], groups: [{ key: "constituents", collectionPath: "product.secretList[]", cells: [], confidence: 0.9, rationale: "x" }] })) });
  assert("an invented collection is refused", o.groups.constituents?.status === "invalid", o.groups);

  console.log("\n🧪 Saving AI mappings: pending → blocks activation → confirm → memory");
  const mapped = (await mapFields(addvet.id, company.id, { fields: addFields }, { generate: goldenModel(ADD) })).mappings;
  const toPut = (overrides = {}) =>
    addFields.map(({ proposedLabel, labelContext, ...f }) => {
      const mp = mapped[f.key];
      return { ...f, source: mp.source, format: mp.format ?? null, required: mp.required, mappingOrigin: mp.origin === "none" ? "manual" : mp.origin, mappingSuggestionId: mp.suggestionId ?? null, dataCategory: mp.category, ...(overrides[f.key] || {}) };
    });
  r = await api("PUT", `/template-versions/${addvet.id}/fields`, A, { fields: toPut() });
  assert("PUT with the mappings → 200", r.status === 200, r.data);
  const stored = Object.fromEntries((r.data?.data?.fields || []).map((f) => [f.key, f]));
  assert("AI mappings stored pending (mappingConfirmed false)", stored.constituent_2_amount?.mappingOrigin === "ai" && stored.constituent_2_amount.mappingConfirmed === false && stored.document_no.mappingConfirmed === false, stored.constituent_2_amount);
  assert("code mappings stored settled, with their category", stored.batch_no.mappingOrigin === "dictionary" && stored.batch_no.mappingConfirmed && stored.ph_result.dataCategory === "batch_data");
  r = await api("PUT", `/template-versions/${addvet.id}/fields`, A, { fields: toPut({ document_no: { source: { kind: "template", template: "COA-{{item.batchNo}}" } }, batch_no: { mappingOrigin: "ai", mappingSuggestionId: "00000000-0000-4000-8000-00000000dead" } }) });
  const after = Object.fromEntries((r.data?.data?.fields || []).map((f) => [f.key, f]));
  assert("a person's edit settles the field (manual, confirmed)", after.document_no?.mappingOrigin === "manual" && after.document_no.mappingConfirmed === true, after.document_no);
  const edited = await prisma.aiSuggestion.findUnique({ where: { id: mapped.document_no.suggestionId } });
  assert("… and the suggestion is recorded as edited, with what was kept", edited.status === "edited" && edited.finalValue.source.template === "COA-{{item.batchNo}}");
  assert("a client claiming an AI origin without a real suggestion → manual", after.batch_no.mappingOrigin === "manual" && after.batch_no.mappingSuggestionId === null);
  r = await api("POST", `/template-versions/${addvet.id}/prepare`, A);
  const task = r.status === 202 ? await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 }) : null;
  assert("prepare → ready", task?.status === "completed", task || r.data);
  r = await api("POST", `/template-versions/${addvet.id}/activate`, A);
  assert("activate with pending AI mappings → 409 FIELDS_UNCONFIRMED listing them", r.status === 409 && r.data.code === "FIELDS_UNCONFIRMED" && JSON.stringify(r.data.mappings.sort()) === JSON.stringify(["constituent_2_amount", "constituent_2_name"]), r.data);
  r = await api("POST", `/template-versions/${addvet.id}/fields/confirm`, A, { keys: ["constituent_2_name", "constituent_2_amount"] });
  assert("confirm → 200, settled", r.status === 200 && r.data.data.fields.every((f) => f.mappingConfirmed), r.data);
  const accepted = await prisma.aiSuggestion.findUnique({ where: { id: mapped.constituent_2_amount.suggestionId } });
  assert("… the suggestion is accepted by that person", accepted.status === "accepted" && accepted.decidedAt);
  assert("… and remembered right away", (await prisma.fieldMappingMemory.count({ where: { companyId: company.id } })) === 2);
  r = await api("POST", `/template-versions/${addvet.id}/activate`, A);
  assert("activate → 200, every label remembered", r.status === 200 && r.data.data.remembered === 8, r.data);
  const mem = await prisma.fieldMappingMemory.findMany({ where: { companyId: company.id } });
  assert("memory rows: label → source/format/category", mem.length === 8 && mem.find((x) => x.labelNorm === "expiry date")?.format?.date === "MM/YYYY" && mem.find((x) => x.labelNorm === "ph result")?.category === "batch_data");
  assert("… times used counts a re-confirmation", mem.find((x) => x.labelNorm === "sodium selenite result").timesUsed === 2);

  console.log("\n🧪 Memory: a second template with the same labels → 0 AI calls");
  const addvet2 = await uploadGolden(company.id, typeId, ADD, "SA");
  const calls2 = [];
  g = await runGolden(company.id, addvet2, ADD, { generate: goldenModel(ADD, { calls: calls2 }) });
  assert("0 AI calls", calls2.length === 0 && g.out.ai.calls === 0, calls2.length);
  assert("every field from memory, settled", Object.values(g.out.mappings).every((x) => x.origin === "memory" && x.status === "accepted"), Object.values(g.out.mappings).map((x) => x.origin));
  assert("same sources as confirmed on the first (the edit included)", g.out.mappings.document_no.source.template === "COA-{{item.batchNo}}" && g.out.mappings.constituent_2_amount.source.path === "activeIngredients[1].concentration");
  const misses = g.score.perField.filter((x) => !x.ok).map((x) => x.key);
  assert("golden set: every field as expected except the one the user deliberately changed (document_no)", JSON.stringify(misses) === JSON.stringify(["document_no"]), misses);

  console.log("\n🧪 “Why?” — GET /ai-suggestions/:id");
  r = await api("GET", `/ai-suggestions/${mapped.constituent_2_name.suggestionId}`, A);
  assert("own → 200 with proposal, confidence, rationale", r.status === 200 && r.data.data.suggestion.proposal.source && typeof r.data.data.suggestion.confidence === "number");
  r = await api("GET", `/ai-suggestions/${mapped.constituent_2_name.suggestionId}`, B);
  assert("another tenant → 404", r.status === 404, r.status);
  r = await api("POST", `/template-versions/${pharma.id}/map-fields`, A, {});
  assert("map-fields without fields → 400", r.status === 400, r.status);
  r = await api("POST", `/template-versions/${pharma.id}/map-fields`, B, { fields: pFields.map(({ proposedLabel, charStart, charEnd, ...f }) => f) });
  assert("map-fields on another tenant's version → 404", r.status === 404, r.status);
  r = await api("POST", `/template-versions/${pharma.id}/map-fields?companyId=${company.id}`, asAdmin, { fields: pFields.map(({ proposedLabel, charStart, charEnd, ...f }) => f) });
  assert("a system user may map for the company", r.status === 200, r.status);
} finally {
  await finish(counts, async () => {
    await closeQueues();
    await prisma.fieldMappingMemory.deleteMany({ where: { companyId: company.id } });
    await cleanupCompany(company.id);
    await cleanupCompany(coB.id);
  });
}
