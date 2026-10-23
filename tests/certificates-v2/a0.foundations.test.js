// Certificate AI layers — Phase A0 Foundations (plan.md §11 row A0).
// Exit criterion proven here: a company's JSON product data is pickable in
// the wizard ("Specifications › pH", "Active ingredients › [Vitamin E] ›
// concentration") and a render shows the right values. Also: the dictionary
// is per company (P6), rebuild triggers, AI settings, ai_runs records a
// failed call with the AI unavailable (P8), the invoice list omits textContent.
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import fs from "fs";
import path from "path";
import { Queue } from "bullmq";
import { api, asCompany, asAdmin, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";
import { getRedisConfig } from "../../src/lib/redis.js";
import { createProduct } from "../../src/services/productService.js";
import { closeQueues } from "../../src/services/certificates/jobs/queues.js";

const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("a0a");
const coB = await createCompany("a0b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const toDrafts = (name, lines) =>
  golden[name].map((g) => {
    const text = lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });

const PH = "specifications.values.pH";
const VIT_E = 'activeIngredients[name="Vitamin E"].concentration';
const SELENITE = 'activeIngredients[name="Sodium selenite"].concentration';

try {
  // realistic JSON: key spellings differ between products, ingredient order differs
  const p1 = await prisma.product.create({
    data: {
      companyId: coA.id,
      name: "ADD-E120 FORTE",
      producer: "ADDVET",
      specifications: { type: "string", values: { pH: "4.0", "Assay %": "102.7" } },
      activeIngredients: [{ name: "Vitamin E", concentration: "120000 mg" }, { name: "Sodium selenite", concentration: "75 mg" }],
    },
  });
  await prisma.product.create({
    data: {
      companyId: coA.id,
      name: "ADD-SE",
      specifications: { values: { PH: "6.5" } },
      activeIngredients: [{ name: "sodium selenite", concentration: "60 mg" }, { name: "Vitamin E", concentration: "50 g" }],
    },
  });
  await prisma.product.create({ data: { companyId: coB.id, name: "B only", specifications: { values: { secretKeyB: "b-value" } } } });

  console.log("\n🧪 Data dictionary (built lazily, per company)");
  let r = await api("GET", "/certificate-data-dictionary", A);
  const dict = r.data?.data?.dictionary;
  assert("GET → 200, built on first use", r.status === 200 && dict?.version >= 1 && dict.productCount === 2, r.data);
  const entry = (p) => dict?.entries?.find((e) => e.path === p);
  assert("pH and PH are one entry, coverage 100 %", entry(`product.${PH}`)?.coverage === 1 && entry(`product.${PH}`).labels.length === 2, entry(`product.${PH}`));
  assert('[name="Vitamin E"].concentration listed with examples', entry(`product.${VIT_E}`)?.examples?.includes("120000 mg"), entry(`product.${VIT_E}`));
  assert("schema entries carry coverage too (producer 50 %)", entry("product.producer")?.coverage === 0.5);
  assert("no other tenant's keys (P6)", !JSON.stringify(dict).includes("secretKeyB") && !JSON.stringify(dict).includes("b-value"));
  r = await api("GET", "/certificate-data-dictionary", B);
  assert("company B sees only its own keys", r.status === 200 && JSON.stringify(r.data.data.dictionary).includes("secretKeyB") && !JSON.stringify(r.data.data.dictionary).includes("Vitamin E"));
  r = await api("GET", "/certificate-data-dictionary", asAdmin);
  assert("system user without companyId → 400", r.status === 400, r.status);
  r = await api("GET", `/certificate-data-dictionary?companyId=${coA.id}`, asAdmin);
  assert("system user with ?companyId= → that company's dictionary", r.status === 200 && r.data.data.dictionary.productCount === 2);

  console.log("\n🧪 Source picker reads the dictionary");
  r = await api("GET", "/certificate-field-sources", A);
  const productPaths = r.data?.data?.kinds?.find((k) => k.kind === "product")?.paths || [];
  const opt = (p) => productPaths.find((x) => x.path === p);
  assert("“Specifications › pH” is a pickable product path", opt(PH)?.label === "Specifications › pH" && opt(PH).coverage === 1, opt(PH));
  assert("“Active ingredients › [Vitamin E] › Concentration” is pickable", opt(VIT_E)?.label === "Active ingredients › [Vitamin E] › Concentration", opt(VIT_E));
  assert("… with examples", opt(VIT_E)?.examples?.length === 2);
  assert("the V2 static paths are still there (old fields keep their labels)", !!opt("activeIngredients[1].concentration") && !!opt("producer"));
  assert("dictionary version is reported", r.data?.data?.dictionary?.version >= 1);
  r = await api("GET", "/certificate-field-sources", B);
  assert("company B's picker has none of A's keys", !(r.data?.data?.kinds || []).find((k) => k.kind === "product").paths.some((p) => p.path === VIT_E));
  r = await api("GET", "/certificate-field-sources", asAdmin);
  assert("system user without a company → the static catalogue (unchanged)", r.status === 200 && !r.data.data.dictionary);
  r = await api("GET", `/certificate-field-sources?companyId=00000000-0000-4000-8000-000000000000`, asAdmin);
  assert("unknown company → 404", r.status === 404, r.status);

  console.log("\n🧪 Rebuild triggers");
  await prisma.product.update({ where: { id: p1.id }, data: { specifications: { values: { pH: "4.0", "Assay %": "102.7", "Loss on drying": "≤ 5 %" } } } });
  r = await api("POST", "/certificate-data-dictionary/rebuild", A);
  assert("manual rebuild → version bumps and the new key appears", r.status === 200 && r.data.data.dictionary.version === dict.version + 1 && r.data.data.dictionary.entries.some((e) => e.path === 'product.specifications.values["Loss on drying"]'), r.data?.data?.dictionary?.version);
  r = await api("POST", "/certificate-data-dictionary/rebuild", B);
  assert("rebuild is tenant-forced (B's own)", r.status === 200 && !JSON.stringify(r.data.data.dictionary).includes("Loss on drying"));
  const before = await prisma.dataDictionary.findUnique({ where: { companyId: coA.id } });
  await createProduct(coA.id, { name: `A0 trigger ${Date.now()}` });
  const queue = new Queue("certificateTemplateQueue", { connection: getRedisConfig() });
  const mine = async () => (await queue.getJobs(["delayed", "waiting", "active"])).filter((j) => j.name === "rebuildDictionary" && j.data.companyId === coA.id);
  let pending = await mine();
  assert("a product save schedules a rebuild within seconds (debounced, not throttled)", pending.length === 1 && pending[0].delay <= 5000, pending.map((j) => [j.id, j.delay]));
  await createProduct(coA.id, { name: `A0 trigger 2 ${Date.now()}` });
  pending = await mine();
  assert("a second save right after still makes one rebuild", pending.length === 1, pending.length);
  let after = null;
  for (let i = 0; i < 20 && !(after && after.version > before.version); i++) {
    await new Promise((res) => setTimeout(res, 1000));
    after = await prisma.dataDictionary.findUnique({ where: { companyId: coA.id } });
  }
  assert("…which the worker runs: the dictionary now counts both new products", after.version === before.version + 1 && after.productCount === before.productCount + 2, { before: [before.version, before.productCount], after: [after?.version, after?.productCount] });
  const schedulers = await queue.getJobSchedulers();
  assert("nightly rebuild is scheduled", schedulers.some((s) => s.key === "certificates-dictionary-nightly" || s.id === "certificates-dictionary-nightly"), schedulers.map((s) => s.key || s.id));
  await queue.close();

  console.log("\n🧪 Exit criterion: pick JSON paths by hand → the render shows the values");
  r = await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" });
  const typeId = r.data.data.type.id;
  const addvet = await uploadTemplate(coA.id, { file: "ADDVET_COA.ai", certificateTypeId: typeId });
  const av = addvet.version;
  assert("ADDVET golden converted to draft", av?.status === "draft");
  const fields = toDrafts("ADDVET_COA.ai", av.lines).map((f) => {
    if (f.key === "ph_result") return { ...f, source: { kind: "product", path: PH } };
    if (f.key === "constituent_2_amount") return { ...f, source: { kind: "product", path: SELENITE } };
    return f;
  });
  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields });
  assert("PUT fields with grammar paths → 200", r.status === 200, r.data);
  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields: fields.map((f) => (f.key === "ph_result" ? { ...f, source: { kind: "product", path: "name.first" } } : f)) });
  assert("a path inside a scalar column is refused → 400/422", [400, 422].includes(r.status), r.status);
  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields });
  r = await api("POST", `/template-versions/${av.id}/prepare`, A);
  const task = r.status === 202 ? await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 }) : null;
  assert("prepare → ready", task?.status === "completed", task || r.data);
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { productId: p1.id });
  const vals = r.data?.data?.values || {};
  assert("Specifications › pH resolves on the product", vals.ph_result?.value === "4.0", vals.ph_result);
  assert('[name="Sodium selenite"] resolves whatever the ingredient order', vals.constituent_2_amount?.value === "75 mg", vals.constituent_2_amount);
  assert("… and both are rendered", r.data?.data?.html?.includes(">75 mg<") && r.data.data.html.includes(">4.0<"));
  const p2 = await prisma.product.findFirst({ where: { companyId: coA.id, name: "ADD-SE" } });
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { productId: p2.id });
  assert("second product: PH spelling and lower-case ingredient name still resolve", r.data?.data?.values?.ph_result?.value === "6.5" && r.data.data.values.constituent_2_amount.value === "60 mg", r.data?.data?.values);

  console.log("\n🧪 AI settings (plan.md §3.3)");
  r = await api("GET", "/certificate-ai-settings", A);
  assert("defaults: on, threshold 0.9, auto-accept off (§12 Q1)", r.status === 200 && r.data.data.settings.enabled === true && r.data.data.settings.autoAcceptThreshold === 0.9 && r.data.data.settings.autoAccept === false, r.data);
  r = await api("PATCH", "/certificate-ai-settings", A, { autoAccept: true, autoAcceptThreshold: 0.95, allowAiMatching: false });
  assert("PATCH → merged settings", r.status === 200 && r.data.data.settings.autoAcceptThreshold === 0.95 && r.data.data.settings.allowAiMatching === false && r.data.data.settings.allowSynonyms === true, r.data);
  r = await api("PATCH", "/certificate-ai-settings", A, { autoAcceptThreshold: 0.2 });
  assert("threshold below 0.5 → 400", r.status === 400, r.status);
  r = await api("PATCH", "/certificate-ai-settings", A, { surprise: true });
  assert("unknown setting → 400", r.status === 400, r.status);
  r = await api("GET", "/certificate-ai-settings", B);
  assert("company B still has the defaults", r.data?.data?.settings?.autoAcceptThreshold === 0.9 && r.data.data.settings.allowAiMatching === true);
  r = await api("PATCH", `/certificate-ai-settings?companyId=${coB.id}`, asAdmin, { enabled: false });
  assert("system user sets a named company's settings", r.status === 200 && r.data.data.settings.enabled === false);
  assert("… stored on that company only", (await prisma.company.findUnique({ where: { id: coA.id } })).aiSettings.enabled === true);

  console.log("\n🧪 ai_runs: a call with the AI unavailable is recorded, nothing breaks (P8)");
  const pharma = await uploadTemplate(coA.id, { file: "PHARMAVET_COA.pdf", certificateTypeId: typeId, country: "TR" });
  r = await api("POST", `/template-versions/${pharma.version.id}/suggest`, A);
  assert("suggest with Gemini disabled → an error, not a hang", r.status >= 400, r.status);
  const runs = await prisma.aiRun.findMany({ where: { companyId: coA.id, kind: "CERT_ASSIST" } });
  assert("… recorded: failed, with model, promptHash, inputHash and the reason", runs.length === 1 && runs[0].outcome === "failed" && runs[0].modelId && runs[0].promptHash && runs[0].inputHash && runs[0].entityId === pharma.version.id && /disabled|GEMINI/i.test(runs[0].error), runs);
  r = await api("PUT", `/template-versions/${pharma.version.id}/fields`, A, { fields: toDrafts("PHARMAVET_COA.pdf", pharma.version.lines) });
  assert("marking fields by hand still works", r.status === 200, r.data);
  assert("no ai_runs row for company B", (await prisma.aiRun.count({ where: { companyId: coB.id } })) === 0);

  console.log("\n🧪 Invoice textContent (plan.md §6.1)");
  const MARK = `TEXTMARK-${Date.now()}`; // appears only in the stored text
  const inv = await prisma.invoice.create({ data: { companyId: coA.id, status: "review", sourceFileId: "00000000-0000-4000-8000-000000000001", header: {}, textContent: `=== Page 1 ===\nBatch: HSPhar02509001 ${MARK}` } });
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: { name: "ADD-E120 FORTE" }, dataExtracted: {}, productId: p1.id, matchStatus: "matched", matchMethod: "user" } });
  r = await api("GET", `/invoices/${inv.id}`, A);
  assert("GET /invoices/:id includes textContent", r.status === 200 && r.data.data.invoice?.textContent?.includes(MARK), r.data?.data?.invoice ? Object.keys(r.data.data.invoice) : r.data);
  r = await api("GET", `/invoices/${inv.id}?companyId=${coA.id}`, asAdmin);
  assert("… also for a system user acting for that company", r.status === 200 && r.data.data.invoice?.textContent?.includes(MARK));
  r = await api("GET", `/invoices/${inv.id}`, B);
  assert("another tenant → 404, and the text is not in the body", r.status === 404 && !JSON.stringify(r.data).includes(MARK), r.status);
  for (const [label, url, headers] of [
    ["company list", "/invoices", A],
    ["company list, searched", "/invoices?q=HSPhar", A],
    ["company list, filtered by status", "/invoices?status=review&limit=100", A],
    ["system user list", `/invoices?companyId=${coA.id}&limit=100`, asAdmin],
  ]) {
    r = await api("GET", url, headers);
    const raw = JSON.stringify(r.data);
    assert(`${label}: payload never contains textContent`, r.status === 200 && !raw.includes(MARK) && !raw.includes('"textContent"'), r.status);
  }
  assert("… and the invoice is in the list (the check above is not vacuous)", (await api("GET", "/invoices?limit=100", A)).data?.data?.invoices?.some((x) => x.id === inv.id));
  r = await api("PATCH", `/invoices/${inv.id}`, A, { header: { invoiceNumber: "A0-1" } });
  assert("PATCH /invoices/:id response omits it", r.status === 200 && !JSON.stringify(r.data).includes(MARK) && !("textContent" in r.data.data.invoice), r.status);
  r = await api("POST", `/invoices/${inv.id}/confirm`, A);
  assert("POST /invoices/:id/confirm response omits it", r.status === 200 && !JSON.stringify(r.data).includes(MARK) && !("textContent" in r.data.data.invoice), r.data);
  assert("… and it is still stored", (await prisma.invoice.findUnique({ where: { id: inv.id } })).textContent.includes(MARK));
} finally {
  await finish(counts, async () => {
    await closeQueues();
    await cleanupCompany(coA.id);
    await cleanupCompany(coB.id);
  });
}
