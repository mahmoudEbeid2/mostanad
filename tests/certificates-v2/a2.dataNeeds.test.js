// Certificate AI layers — Phase A2 invoice intelligence (plan.md §6, §6.4).
// The model is a deterministic stand-in (npm test never calls a paid API);
// the live gap-fill run is scripts/evalCertGaps.js (RUN_LIVE_GEMINI=1).
// Proven here:
//  - 3 golden invoices: every resolvable gap filled with VERIFIED evidence by a correct model,
//    nothing filled that isn't written anywhere, ONE call per invoice
//  - adversarial answers refused (P2): a plausible value not in the text, a quote without the value,
//    a product path whose DB value differs (DB wins), a product-text quote not in the product,
//    a batch number quoted from the OTHER line's row
//  - AI off / AI down → the check is still computed, gaps stay missing (P8)
//  - cost: ≤ 1 call per invoice, 0 when nothing new is missing; edits re-run code only
//  - decisions: accept / edit (once per line for every certificate type) / reject / reset
//  - near-miss → "add as synonym for all products" → code resolves it from then on
//  - tenancy: another company's invoice is 404; prompts carry only the caller's data (P6)
//  - generation: blocked while required values are open (unless "generate anyway"), and
//    renders exactly what the check settled, with provenance (plan.md §4)
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service (generation part).
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma, confirmFirst } from "./helpers.js";
import { seedGoldenCompany, seedTemplate, loadGoldenInvoice, runGoldenInvoice, goldenModel, golden, needFor, INVOICES } from "./invoiceGoldenHarness.js";
import { computeNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";
import { closeQueues } from "../../src/services/certificates/jobs/queues.js";

const { assert, counts } = makeAssert();
const seed = await seedGoldenCompany("a2a");
const coB = await createCompany("a2b");
const coG = await createCompany("a2g");
const A = asCompany(seed.company.id);
const B = asCompany(coB.id);
const G = asCompany(coG.id);
// these suites test the confirm-first mechanics (A2); "fill automatically" defaults are proven in b3
for (const c of [seed.company.id, coB.id, coG.id]) await confirmFirst(c);
const cid = seed.company.id;
const exp = (name) => golden(name).expected;
const gapOf = (check, inv, line, field) => needFor(check, inv, seed.templates, { line, field });

try {
  await prisma.product.create({ data: { companyId: coB.id, name: "B-SECRET-PRODUCT", description: "b-secret-text", specifications: { values: { pH: "b-secret" } } } });

  console.log("\n🧪 Golden invoices with a correct stand-in model (§6.4)");
  let resolvable = 0;
  let filled = 0;
  for (const name of INVOICES) {
    const calls = [];
    const { score, check } = await runGoldenInvoice(seed, name, { generate: goldenModel(exp(name), { calls }) });
    resolvable += score.resolvable;
    filled += score.filled;
    assert(`${name}: ${score.filled}/${score.resolvable} resolvable gaps filled with verified evidence`, score.filled === score.resolvable, score.perGap.filter((g) => !g.ok));
    assert(`${name}: 0 false fills, 0 unverified AI values`, score.falseFills === 0 && score.unverified === 0, score);
    assert(`${name}: code resolved its part (${score.codeResolved}/${score.codeExpected})`, score.codeResolved === score.codeExpected, score);
    assert(`${name}: exactly ONE gap call`, calls.length === 1 && check.ai.calls === 1, calls.length);
    assert(`${name}: AI values wait for a person (auto-accept off, §12 Q1)`, check.summary.resolvedAi === 0 && check.summary.needsConfirmation === score.filled, check.summary);
  }
  assert(`gap fill overall ≥ 80 % (${filled}/${resolvable})`, filled / resolvable >= 0.8);

  console.log("\n🧪 What the stand-in run stored");
  const invA = await loadGoldenInvoice(cid, seed.products, "INV_A");
  const calls = [];
  let check = await computeNeeds(invA.id, cid, { generate: goldenModel(exp("INV_A"), { calls }) });
  const prod1 = gapOf(check, invA, 1, "production");
  assert("a date found in the text is stored as ISO and shown in the field's format", prod1.value === "2026-04" && prod1.display === "04/2026", prod1);
  assert("provenance: invoice_text, the exact quote, page, offsets, suggestion, confidence", prod1.provenance.kind === "invoice_text" && prod1.provenance.quote === "Mfg 04/2026" && prod1.provenance.page === 1 && prod1.provenance.suggestionId && prod1.provenance.confidence === 0.92, prod1.provenance);
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invA.id }, orderBy: { lineNo: "asc" } });
  assert("each line's row located in the text (code)", items.every((i) => i.textSpan?.start >= 0 && i.textSpan.via === "line_search"), items.map((i) => i.textSpan));
  const sugg = await prisma.aiSuggestion.findUnique({ where: { id: prod1.suggestionId } });
  assert("AiSuggestion: invoice_gap, verified, provenance (P7)", sugg.kind === "invoice_gap" && sugg.evidenceVerified === true && sugg.modelId && sugg.promptHash && sugg.inputHash && sugg.aiRunId, sugg);
  const run = await prisma.aiRun.findUnique({ where: { id: sugg.aiRunId } });
  assert("ai_runs row: CERT_INVOICE_GAPS ok", run.kind === "CERT_INVOICE_GAPS" && run.outcome === "ok" && run.entityId === invA.id);
  const wd = gapOf(check, invA, 2, "withdrawal");
  assert("product_json_text: value from the product's own text", wd.status === "needs_confirmation" && wd.value === "7 days for meat" && wd.provenance.kind === "product_json_text" && wd.provenance.path === "product.description", wd);
  assert("batch-data form: one entry per line and label", check.batchData.length === 2 && check.batchData[0].fields.find((f) => f.labelKey === "ph result")?.needIds.length === 1, check.batchData);

  console.log("\n🧪 Prompt: order and tenant isolation (P6)");
  const prompt = JSON.stringify(calls[0].contents);
  assert("instructions → invoice text → products → gaps", calls[0].contents[1].startsWith("Invoice text:") && calls[0].contents[2].startsWith("Invoice (extracted)") && calls[0].contents[3].startsWith("Gaps:"));
  assert("no other company's data in the prompt", !prompt.includes("B-SECRET") && !prompt.includes("b-secret"));
  assert("the matched products' raw JSON is included (8 KB cap)", prompt.includes("Sodium selenite and vitamin E oral solution"));
  assert("gaps carry scope and line", /"scope":"line","lineNo":1/.test(calls[0].contents[3]) && /"scope":"header"/.test(calls[0].contents[3]));

  console.log("\n🧪 Cost: re-runs don't ask again (§6.2 re-runs, §6.4 cost)");
  const again = [];
  check = await computeNeeds(invA.id, cid, { generate: goldenModel(exp("INV_A"), { calls: again }) });
  assert("second check → 0 AI calls (nothing new missing)", again.length === 0 && check.ai.calls === 0);
  let r = await api("PATCH", `/invoices/${invA.id}/items/${items[0].id}`, A, { data: { productionDate: "05/2026" } });
  check = await computeNeeds(invA.id, cid, { generate: goldenModel(exp("INV_A"), { calls: again }) });
  assert("an edited line re-resolves by code, no AI call", again.length === 0 && gapOf(check, invA, 1, "production").status === "resolved" && gapOf(check, invA, 1, "production").value === "2026-05");
  r = await api("PATCH", `/invoices/${invA.id}/items/${items[0].id}`, A, { data: { productionDate: null } });
  check = await computeNeeds(invA.id, cid, { generate: goldenModel(exp("INV_A"), { calls: again }) });
  assert("cleared again → that ONE gap is asked (1 call, 1 gap)", again.length === 1 && JSON.parse(again[0].contents[3].slice(6)).length === 1, again.length);

  const conc = await loadGoldenInvoice(cid, seed.products, "INV_C");
  const concCalls = [];
  const settled = await Promise.allSettled([1, 2, 3].map(() => computeNeeds(conc.id, cid, { generate: goldenModel(exp("INV_C"), { calls: concCalls }) })));
  assert("three checks at once (the review screen re-rendering) → all succeed, ONE AI call", settled.every((x) => x.status === "fulfilled") && concCalls.length === 1, settled.map((x) => x.reason?.message));

  console.log("\n🧪 Adversarial answers (§6.4, P2)");
  const adv = async (name, override) => {
    const inv = await loadGoldenInvoice(cid, seed.products, name);
    const chk = await computeNeeds(inv.id, cid, { generate: goldenModel(exp(name), { override }) });
    return { inv, chk };
  };
  let t = await adv("INV_A", (g) => (g.fieldKey === "production" && g.lineNo === 1 ? { found: true, value: "05/2026", evidence: [{ type: "invoice_text", quote: "Mfg 05/2026" }], confidence: 0.99 } : null));
  let n = gapOf(t.chk, t.inv, 1, "production");
  assert("a plausible value not in the text → rejected, stays missing", n.status === "missing" && n.value === null, n);
  let s = await prisma.aiSuggestion.findUnique({ where: { id: n.suggestionId } });
  assert("… logged with evidenceVerified=false, status rejected, reason", s.evidenceVerified === false && s.status === "rejected" && /not in the invoice text/.test(JSON.stringify(s.finalValue)), s.finalValue);
  t = await adv("INV_A", (g) => (g.fieldKey === "ph_result" && g.lineNo === 1 ? { found: true, value: "4.4", evidence: [{ type: "invoice_text", quote: "pH 4.1" }], confidence: 0.95 } : null));
  assert("the quote is there but the value isn't in it → rejected", gapOf(t.chk, t.inv, 1, "ph_result").status === "missing");
  t = await adv("INV_A", (g) => (g.fieldKey === "ph_result" && g.lineNo === 1 ? { found: true, value: "5.2", evidence: [{ type: "invoice_text", quote: "pH 5.2" }], confidence: 0.95 } : null));
  assert("two lines: line 2's real value quoted for line 1 → rejected", gapOf(t.chk, t.inv, 1, "ph_result").status === "missing" && gapOf(t.chk, t.inv, 2, "ph_result").value === "5.2");
  t = await adv("INV_A", (g) => (g.fieldKey === "withdrawal" ? { found: true, value: "14 days", evidence: [{ type: "product_json_text", path: "description", quote: "Withdrawal period: 14 days" }], confidence: 0.95 } : null));
  assert("a product-text quote not in the product's string → rejected", gapOf(t.chk, t.inv, 2, "withdrawal").status === "missing");
  t = await adv("INV_C", (g) => (g.fieldKey === "ph_spec" && g.lineNo === 1 ? { found: true, value: "9.9", evidence: [{ type: "product_path", path: 'specifications.values["PH value"]' }], confidence: 0.95 } : null));
  n = gapOf(t.chk, t.inv, 1, "ph_spec");
  assert("a product-path value that differs from the DB → the DB value wins", n.status === "needs_confirmation" && n.value === "5.5-6.5" && n.provenance.kind === "product_path", n);
  assert("… flagged as a near miss (synonym offer)", n.provenance.nearMiss?.canonical === "product.specifications.values.pH" && n.provenance.nearMiss.alternative === 'product.specifications.values["PH value"]', n.provenance);
  t = await adv("INV_B", (g) => (g.fieldKey === "ph_result" ? { found: true, value: "4.0", evidence: [], confidence: 1 } : null));
  assert("found with no evidence → rejected", gapOf(t.chk, t.inv, 1, "ph_result").status === "missing");
  t = await adv("INV_C", (g) => (g.fieldKey === "withdrawal" && g.lineNo === 2 ? { found: true, value: "x", evidence: [{ type: "product_path", path: "constructor" }], confidence: 1 } : null));
  assert("a product path to a forbidden key → rejected", gapOf(t.chk, t.inv, 2, "withdrawal").status === "missing");
  assert("0 unverified values ever reached resolved_ai / needs_confirmation", (await prisma.$queryRaw`SELECT count(*)::int AS n FROM certificate_data_needs d JOIN ai_suggestions s ON s.id = d.suggestion_id WHERE d.company_id = ${cid} AND d.status IN ('resolved_ai','needs_confirmation') AND s.evidence_verified IS NOT TRUE`)[0].n === 0);

  console.log("\n🧪 AI off / AI down → still computed, gaps missing (P8)");
  await api("PATCH", "/certificate-ai-settings", A, { allowInvoiceGapFill: false });
  const offCalls = [];
  const invOff = await loadGoldenInvoice(cid, seed.products, "INV_B");
  check = await computeNeeds(invOff.id, cid, { generate: goldenModel(exp("INV_B"), { calls: offCalls }) });
  assert("gap fill off → no call, needs computed, gaps missing, reason given", offCalls.length === 0 && check.ai.unavailable && /turned off/.test(check.ai.reason) && check.summary.missing === 4 && check.summary.resolved === 8, check.ai);
  assert("… recorded as disabled in ai_runs", (await prisma.aiRun.count({ where: { companyId: cid, kind: "CERT_INVOICE_GAPS", outcome: "disabled" } })) >= 1);
  await api("PATCH", "/certificate-ai-settings", A, { allowInvoiceGapFill: true });
  check = await computeNeeds(invOff.id, cid, { generate: async () => { throw Object.assign(new Error("429 RESOURCE_EXHAUSTED quota"), { statusCode: 429 }); } });
  assert("model over quota → unavailable, said as a sentence, gaps missing", check.ai.unavailable && /usage limit/.test(check.ai.reason) && !/RESOURCE_EXHAUSTED/.test(check.ai.reason) && check.summary.missing === 4, check.ai);
  const retry = [];
  check = await computeNeeds(invOff.id, cid, { generate: goldenModel(exp("INV_B"), { calls: retry }) });
  assert("a failed call is asked again next time", retry.length === 1 && check.summary.needsConfirmation === 2, check.summary);
  r = await api("POST", `/invoices/${invOff.id}/data-needs`, A, {});
  assert("API with Gemini disabled in tests → 200, nothing new to ask (0 calls)", r.status === 200 && r.data.data.check.ai.calls === 0, r.data);
  const invDown = await loadGoldenInvoice(cid, seed.products, "INV_C");
  r = await api("POST", `/invoices/${invDown.id}/data-needs`, A, {});
  assert("API, AI unavailable (GEMINI_DISABLED) → 200, unavailable, gaps missing", r.status === 200 && r.data.data.check.ai.unavailable === true && r.data.data.check.summary.missing === 8, r.data?.data?.check?.ai);
  r = await api("POST", `/invoices/${invDown.id}/data-needs`, A, { ai: false });
  assert("ai:false → code only", r.status === 200 && r.data.data.check.ai.calls === 0 && !r.data.data.check.ai.unavailable);

  console.log("\n🧪 Decisions (§6.2)");
  // a second certificate type that needs the same lab result → the form asks it once per line
  const hc = await seedTemplate(cid, { name: "HC", typeCode: "HC", typeName: "Health Certificate", scope: "per_product", fields: [{ key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data" }, { key: "batch", label: "Batch", source: { kind: "item", path: "batchNo" } }] });
  const invD = await loadGoldenInvoice(cid, seed.products, "INV_A");
  check = await computeNeeds(invD.id, cid, { generate: goldenModel(exp("INV_A")) });
  const line1 = check.batchData.find((b) => b.lineNo === 1);
  const phRow = line1.fields.find((f) => f.labelKey === "ph result");
  assert("batch-data form: pH result asked ONCE for line 1 though COA and HC need it", phRow.needIds.length === 2, phRow);
  r = await api("GET", `/invoices/${invD.id}/data-needs`, A);
  assert("GET → the stored check (summary, certificates, batch data)", r.status === 200 && r.data.data.check.summary.values > 0 && r.data.data.check.certificates.length === 5 && r.data.data.check.batchData.length === 2, r.data?.data?.check?.summary);
  const coaPh = gapOf(check, invD, 1, "ph_result");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: coaPh.id, action: "accept" }] });
  assert("accept a verified AI value → resolved_ai, decided", r.status === 200 && gapOf(r.data.data.check, invD, 1, "ph_result").status === "resolved_ai" && gapOf(r.data.data.check, invD, 1, "ph_result").decidedAt, { status: r.status, data: r.data?.data ? gapOf(r.data.data.check, invD, 1, "ph_result") : r.data, before: coaPh });
  assert("… its suggestion recorded as accepted", (await prisma.aiSuggestion.findUnique({ where: { id: coaPh.suggestionId } })).status === "accepted");
  const hcPh = r.data.data.check.certificates.find((c) => c.planKey === `${hc.versionId}:${invD.items[0].id}`).needs.find((x) => x.fieldKey === "ph_result");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: hcPh.id, action: "edit", value: "4.15", applyTo: "line" }] });
  const after = r.data.data.check;
  assert("edit with applyTo line → every certificate of that line gets it (provided, manual)", gapOf(after, invD, 1, "ph_result").status === "provided" && gapOf(after, invD, 1, "ph_result").value === "4.15" && gapOf(after, invD, 1, "ph_result").provenance.kind === "manual", gapOf(after, invD, 1, "ph_result"));
  assert("… the other line is untouched", gapOf(after, invD, 2, "ph_result").value === "5.2");
  const ph2 = gapOf(after, invD, 2, "ph_result");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: ph2.id, action: "reject" }] });
  assert("reject → missing, suggestion rejected", gapOf(r.data.data.check, invD, 2, "ph_result").status === "missing" && (await prisma.aiSuggestion.findUnique({ where: { id: ph2.suggestionId } })).status === "rejected");
  const rejCalls = [];
  check = await computeNeeds(invD.id, cid, { generate: goldenModel(exp("INV_A"), { calls: rejCalls }) });
  assert("a rejected gap is not asked again", rejCalls.length === 0 && gapOf(check, invD, 2, "ph_result").status === "missing");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: ph2.id, action: "reset" }] });
  check = await computeNeeds(invD.id, cid, { generate: goldenModel(exp("INV_A"), { calls: rejCalls }) });
  assert("reset → recomputed and asked again", rejCalls.length === 1 && gapOf(check, invD, 2, "ph_result").status === "needs_confirmation");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: ph2.id, action: "edit", value: "  " }] });
  assert("edit with an empty value → 422", r.status === 422, r.status);
  const codeNeed = gapOf(check, invD, 1, "batch_no");
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: codeNeed.id, action: "accept" }] });
  assert("accept on a code-resolved value → 409", r.status === 409 && r.data.code === "NOTHING_TO_ACCEPT", r.data);
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, A, { decisions: [{ needId: "00000000-0000-4000-8000-000000000000", action: "accept" }] });
  assert("unknown need → 404", r.status === 404);

  console.log("\n🧪 Near miss → synonym for all products (§6.1)");
  r = await api("POST", "/certificate-data-dictionary/synonyms", A, { canonical: "product.specifications.values.pH", alternative: 'product.specifications.values["PH value"]' });
  assert("synonym added (a person's action)", r.status === 200 && r.data.data.dictionary.entries.find((e) => e.path === "product.specifications.values.pH")?.pathSynonyms?.includes('product.specifications.values["PH value"]'), r.data);
  const invS = await loadGoldenInvoice(cid, seed.products, "INV_C");
  const synCalls = [];
  check = await computeNeeds(invS.id, cid, { generate: goldenModel(exp("INV_C"), { calls: synCalls }) });
  n = gapOf(check, invS, 1, "ph_spec");
  assert("from then on code resolves it (no AI), provenance says via synonym", n.status === "resolved" && n.value === "5.5-6.5" && n.provenance.via === "synonym" && !JSON.parse(synCalls[0].contents[3].slice(6)).some((g) => g.fieldKey === "ph_spec" && g.lineNo === 1), n);
  await api("POST", "/certificate-data-dictionary/rebuild", A);
  r = await api("GET", "/certificate-data-dictionary", A);
  assert("the synonym survives a dictionary rebuild", r.data.data.dictionary.entries.find((e) => e.path === "product.specifications.values.pH")?.pathSynonyms?.length === 1);
  r = await api("POST", "/certificate-data-dictionary/synonyms", A, { canonical: "product.specifications.values.pH", alternative: "product.activeIngredients[0].concentration" });
  assert("a synonym pointing at a list position → 400", r.status === 400, r.data);
  r = await api("POST", "/certificate-data-dictionary/synonyms", A, { canonical: "product.name", alternative: "item.name" });
  assert("a synonym across roots → 400", r.status === 400, r.data);
  r = await api("GET", "/certificate-data-dictionary", B);
  assert("another company's dictionary has no such synonym", !r.data.data.dictionary.entries.some((e) => e.pathSynonyms?.length));

  console.log("\n🧪 Tenancy");
  r = await api("GET", `/invoices/${invD.id}/data-needs`, B);
  assert("GET another company's check → 404", r.status === 404, r.status);
  r = await api("POST", `/invoices/${invD.id}/data-needs`, B, {});
  assert("POST → 404", r.status === 404);
  r = await api("PATCH", `/invoices/${invD.id}/data-needs`, B, { decisions: [{ needId: ph2.id, action: "accept" }] });
  assert("PATCH → 404", r.status === 404);
  const uploaded = await prisma.invoice.create({ data: { companyId: cid, status: "uploaded", sourceFileId: "00000000-0000-4000-8000-0000000000a2" } });
  r = await api("POST", `/invoices/${uploaded.id}/data-needs`, A, {});
  assert("an invoice still being read → 409", r.status === 409 && r.data.code === "INVOICE_NOT_REVIEWED", r.data);

  console.log("\n🧪 Generation: gate + rendering the settled values (plan.md §4, §6.2)");
  r = await api("POST", "/certificate-types", G, { name: "Certificate of Analysis", code: "COA" });
  const typeG = r.data.data.type.id;
  const goldenFields = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"))["ADDVET_COA.ai"].filter((g) => ["batch_no", "production", "ph_result"].includes(g.key));
  const up = await uploadTemplate(coG.id, { file: "ADDVET_COA.ai", name: "ADDVET COA", certificateTypeId: typeG });
  const drafts = goldenFields.map((g) => {
    const text = up.version.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true, ...(g.key === "ph_result" ? { dataCategory: "batch_data" } : {}) };
  });
  r = await api("PUT", `/template-versions/${up.version.id}/fields`, G, { fields: drafts });
  assert("fields saved", r.status === 200, r.data);
  r = await api("POST", `/template-versions/${up.version.id}/prepare`, G);
  const prep = await pollTask(r.data.data.taskId, G, { timeoutMs: 120_000 });
  r = await api("POST", `/template-versions/${up.version.id}/activate`, G);
  assert("template prepared + active", prep?.status === "completed" && r.status === 200, r.data);
  const pG = await prisma.product.create({ data: { companyId: coG.id, name: "ADD-E120", productCode: "ADDE120" } });
  const src = await fileStore.putFile({ companyId: coG.id, kind: "invoice_source", buffer: fs.readFileSync(path.join(FIXTURES, "outlined_text.pdf")), mimeType: "application/pdf" });
  const mkInvoice = async (no, batch = "AVVS77") => {
    const inv = await prisma.invoice.create({ data: { companyId: coG.id, status: "ready", sourceFileId: src.id, header: { invoiceNumber: no }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n1 | ADD-E120 1L | ADDE120 | ${batch} | Mfg 06/2026 | 10` } });
    const data = { name: "ADD-E120 1L", code: "ADDE120", batchNo: batch, productionDate: null, extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: pG.id, matchStatus: "matched", matchMethod: "exact_code" } });
    return inv;
  };
  const invG = await mkInvoice("G-1");
  const stubG = async (args) => {
    const gaps = JSON.parse(args.contents[3].slice(6));
    return { gaps: gaps.map((g) => (g.fieldKey === "production" ? { gapId: g.gapId, found: true, value: "06/2026", evidence: [{ type: "invoice_text", quote: "Mfg 06/2026", page: 1 }], confidence: 0.9 } : { gapId: g.gapId, found: false, evidence: [], confidence: 0 })) };
  };
  check = await computeNeeds(invG.id, coG.id, { generate: stubG });
  assert("check: production found (needs confirmation), pH result missing", check.summary.needsConfirmation === 1 && check.summary.missing === 1, check.summary);
  r = await api("POST", `/invoices/${invG.id}/generate`, G);
  assert("generate while values are open → 409 DATA_NEEDS_OPEN with counts", r.status === 409 && r.data.code === "DATA_NEEDS_OPEN" && r.data.missing === 1 && r.data.needsConfirmation === 1, r.data);
  const needOf = (c, key) => c.certificates[0].needs.find((x) => x.fieldKey === key);
  r = await api("PATCH", `/invoices/${invG.id}/data-needs`, G, { decisions: [{ needId: needOf(check, "production").id, action: "accept" }, { needId: needOf(check, "ph_result").id, action: "edit", value: "4.0" }] });
  assert("accepted + provided → nothing blocks", r.status === 200 && r.data.data.check.summary.blocking === 0, r.data?.data?.check?.summary);
  r = await api("POST", `/invoices/${invG.id}/generate`, G);
  assert("generate → 202", r.status === 202, r.data);
  const task = await pollTask(r.data.data.taskId, G, { timeoutMs: 180_000 });
  const cert = await prisma.certificate.findFirst({ where: { invoiceId: invG.id }, include: { versions: true } });
  const vals = cert?.versions?.[0]?.values || {};
  assert("rendered", task?.status === "completed" && cert.status === "draft", task?.error || cert?.error);
  assert("production = the confirmed AI value, formatted, origin data_check, invoice_text provenance", vals.production?.value === "06/2026" && vals.production.origin === "data_check" && vals.production.provenance?.kind === "invoice_text" && vals.production.provenance.quote === "Mfg 06/2026", vals.production);
  assert("pH result = what the person typed, manual provenance, no missing flag", vals.ph_result?.value === "4.0" && vals.ph_result.origin === "data_check" && vals.ph_result.provenance?.kind === "manual" && !vals.ph_result.flags.includes("missing"), vals.ph_result);
  assert("batch_no from its source as before", vals.batch_no?.value === "AVVS77" && vals.batch_no.origin === "auto");
  r = await api("POST", `/certificates/${cert.id}/fields/ph_result/reset`, G, { expectedVersion: cert.currentVersion });
  const reset = await prisma.certificateVersion.findFirst({ where: { certificateId: cert.id }, orderBy: { versionNumber: "desc" } });
  assert("'reset to source' keeps the check's value (the need comes first)", r.status === 200 && reset.values.ph_result.value === "4.0" && reset.values.ph_result.origin === "data_check", reset.values.ph_result);
  // another batch: its pH result is genuinely open (G-1 batch AVVS77 would reuse 4.0 — item 4)
  const invG2 = await mkInvoice("G-2", "AVVS78");
  await computeNeeds(invG2.id, coG.id, { ai: false });
  r = await api("POST", `/invoices/${invG2.id}/generate`, G, { force: true });
  assert("'Generate anyway' (force, update_certificates) → 202", r.status === 202, r.data);
  const t2 = await pollTask(r.data.data.taskId, G, { timeoutMs: 180_000 });
  const cert2 = await prisma.certificate.findFirst({ where: { invoiceId: invG2.id }, include: { versions: true } });
  assert("… open values render empty and flagged missing (D7)", t2?.status === "completed" && cert2.versions[0].values.ph_result.flags.includes("missing") && cert2.flagCount >= 1, cert2?.versions?.[0]?.values?.ph_result);
  const invG3 = await mkInvoice("G-3");
  r = await api("POST", `/invoices/${invG3.id}/generate`, G);
  assert("an invoice whose check was never run → V2 behaviour (202, flagged)", r.status === 202, r.data);
  await pollTask(r.data.data.taskId, G, { timeoutMs: 180_000 });
} finally {
  await finish(counts, async () => {
    await closeQueues().catch(() => {});
    for (const c of [seed.company.id, coB.id, coG.id]) await cleanupCompany(c);
  });
}
