// Certificates V2 Phase 2 — Fields & prepare (CERTIFICATES_V2_PLAN.md §17 row 2).
//  - source catalogue, field validation (§8.2), server-side align suggestion (D11)
//  - prepare → gate → ready for BOTH golden field sets, report + diff image
//  - prepared / sample HTML, preview with ad-hoc values and with a product
//  - D10: an unconfirmed field blocks activation until confirmed
//  - activate / supersede, new-version clone, draft-only edits
//  - tenancy: every new route is 404 to another company
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";

const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("p2a");
const coB = await createCompany("p2b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const toDrafts = (name, lines) =>
  golden[name].map((g) => {
    const text = lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });

async function prepare(versionId) {
  const r = await api("POST", `/template-versions/${versionId}/prepare`, A);
  if (r.status !== 202) return { r };
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  const v = (await api("GET", `/template-versions/${versionId}`, A)).data?.data?.version;
  return { r, task, v };
}

try {
  let r = await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" });
  const typeId = r.data.data.type.id;
  const addvet = await uploadTemplate(coA.id, { file: "ADDVET_COA.ai", certificateTypeId: typeId });
  const pharma = await uploadTemplate(coA.id, { file: "PHARMAVET_COA.pdf", certificateTypeId: typeId, country: "TR" });
  assert("both goldens converted to draft", addvet.version?.status === "draft" && pharma.version?.status === "draft");
  const av = addvet.version;
  const pv = pharma.version;

  console.log("\n🧪 Source catalogue");
  r = await api("GET", "/certificate-field-sources", A);
  const kinds = r.data?.data?.kinds || [];
  const paths = (k) => kinds.find((x) => x.kind === k)?.paths?.map((p) => p.path) || [];
  assert("catalogue has the 9 source kinds", ["item", "invoice", "product", "company", "brand", "today", "static", "manual", "template"].every((k) => kinds.some((x) => x.kind === k)), kinds.map((k) => k.kind));
  assert("item paths include batchNo / expiryDate", paths("item").includes("batchNo") && paths("item").includes("expiryDate"));
  assert("product paths come from the Prisma model (producer, packaging, ingredients)", ["producer", "packaging", "activeIngredients[0].concentration", "category.name"].every((p) => paths("product").includes(p)));

  console.log("\n🧪 Field validation (§8.2)");
  const addDrafts = toDrafts("ADDVET_COA.ai", av.lines);
  const bad = async (label, mutate, expect) => {
    const fields = structuredClone(addDrafts.slice(0, 2));
    mutate(fields);
    const res = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields });
    const msgs = (res.data?.problems || []).map((p) => p.message).join(" | ");
    assert(`${label} → 422 INVALID_FIELDS (${expect})`, res.status === 422 && res.data?.code === "INVALID_FIELDS" && new RegExp(expect, "i").test(msgs), res.data);
  };
  await bad("key not snake_case", (f) => (f[0].key = "Batch No"), "snake_case");
  await bad("duplicate key", (f) => (f[1].key = f[0].key), "used twice");
  await bad("unknown line", (f) => (f[0].lineId = "p1-l999"), "does not exist");
  await bad("offsets don't hold the sample", (f) => (f[0].charStart += 1), "not \"AVVS");
  await bad("overlapping ranges", (f) => f.push({ ...f[0], key: "batch_overlap", charStart: f[0].charStart + 2, charEnd: f[0].charEnd, sampleValue: f[0].sampleValue.slice(2) }), "overlaps");
  await bad("unknown source path", (f) => (f[0].source = { kind: "product", path: "secretPassword" }), "unknown product path");
  await bad("template placeholder of an unknown kind", (f) => (f[0].source = { kind: "template", template: "{{process.env}}" }), "placeholder");
  await bad("date format on a non-date source", (f) => (f[0].format = { date: "MM/YYYY" }), "date source");
  await bad("invalid align", (f) => (f[0].align = "justify"), "align");

  console.log("\n🧪 Server-side align suggestion (D11)");
  const pDrafts = toDrafts("PHARMAVET_COA.pdf", pv.lines);
  r = await api("PUT", `/template-versions/${pv.id}/fields`, A, { fields: pDrafts.map((f) => ({ ...f, align: "left" })) });
  assert("PUT all-left PHARMAVET fields → 200", r.status === 200, r.data);
  const sug = r.data?.data?.suggestions || {};
  assert("suggests center for exactly expiry, production, batch_no", Object.keys(sug).sort().join(",") === "batch_no,expiry,production" && Object.values(sug).every((s) => s.align === "center"), sug);
  assert("PUT returns server-measured boxes", r.data?.data?.boxes?.expiry?.w > 0, r.data?.data?.boxes);

  console.log("\n🧪 Golden fields → prepare → ready");
  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields: addDrafts });
  assert("PUT ADDVET golden fields → 200 (8 fields)", r.status === 200 && r.data.data.fields.length === 8, r.data);
  assert("manual fields are confirmed (D10)", r.data.data.fields.every((f) => f.origin === "manual" && f.confirmed === true));
  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields: addDrafts });
  assert("PUT again is idempotent", r.status === 200 && r.data.data.fields.length === 8);
  r = await api("PUT", `/template-versions/${pv.id}/fields`, A, { fields: pDrafts });
  assert("PUT PHARMAVET golden fields → 200, no suggestion left", r.status === 200 && Object.keys(r.data.data.suggestions).length === 0, r.data?.data?.suggestions);

  r = await api("POST", `/template-versions/${av.id}/activate`, A);
  assert("activate a draft → 409 VERSION_NOT_READY", r.status === 409 && r.data?.code === "VERSION_NOT_READY", r.data);
  r = await api("GET", `/template-versions/${av.id}/html?variant=prepared`, A);
  assert("prepared HTML before prepare → 409", r.status === 409, r.status);

  for (const [name, v, n] of [["ADDVET", av, 8], ["PHARMAVET", pv, 6]]) {
    const { r: pr, task, v: after } = await prepare(v.id);
    assert(`${name}: prepare → 202`, pr.status === 202, pr.data);
    assert(`${name}: prepare task completed`, task?.status === "completed", task?.error);
    assert(`${name}: version ready`, after?.status === "ready", after?.status + " " + after?.error);
    const rep = after?.prepareReport;
    assert(`${name}: gate passed, pixel diff ≤ 0.05 %`, rep?.passed && rep.pixelDiffPct <= 0.05, rep?.checks?.filter((c) => !c.passed));
    console.log(`     ${name}: pixel diff ${rep?.pixelDiffPct} %`);
    assert(`${name}: every check listed and passing`, rep?.checks?.length === 7 && rep.checks.every((c) => c.passed));
    assert(`${name}: ${n} fields with calibrated geometry`, after.fields.length === n && after.fields.every((f) => f.box && f.limits && typeof f.letterSpacing === "number" && f.scale > 0 && f.fontClass));
    assert(`${name}: report not stale`, after.prepareReportStale === false);
    const diff = await api("GET", `/template-versions/${v.id}/prepare-diff?page=1`, A);
    assert(`${name}: diff image is a PNG`, diff.status === 200 && diff.buffer?.subarray(1, 4).toString() === "PNG", diff.status);
    const prep = await api("GET", `/template-versions/${v.id}/html?variant=prepared`, A);
    const prepHtml = prep.buffer.toString("utf8");
    assert(`${name}: prepared HTML has ${n} empty field spans, CSP`, (prepHtml.match(/<span data-field="[a-z0-9_]+"[^>]*><\/span>/g) || []).length === n && /default-src 'none'/.test(prep.headers.get("content-security-policy")));
    const sample = await api("GET", `/template-versions/${v.id}/html?variant=sample`, A);
    const sHtml = sample.buffer.toString("utf8");
    assert(`${name}: sample HTML holds every sample value`, sample.status === 200 && golden[`${name === "ADDVET" ? "ADDVET_COA.ai" : "PHARMAVET_COA.pdf"}`].every((g) => sHtml.includes(`>${g.sampleValue.replace(/&/g, "&amp;")}<`)));
  }

  r = await api("PUT", `/template-versions/${av.id}/fields`, A, { fields: addDrafts });
  assert("PUT fields on a ready version → 409 VERSION_NOT_DRAFT", r.status === 409 && r.data?.code === "VERSION_NOT_DRAFT", r.data);
  r = await api("POST", `/template-versions/${av.id}/prepare`, A);
  assert("prepare a ready version → 409", r.status === 409, r.status);

  console.log("\n🧪 Preview (test fill, never stored)");
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { values: { batch_no: "AVVS1124011", ph_result: "" } });
  assert("ad-hoc values render", r.status === 200 && r.data.data.html.includes(">AVVS1124011<"), r.data);
  assert("empty required manual value → missing", r.data?.data?.flags?.ph_result?.includes("missing"), r.data?.data?.flags);
  assert("unresolved item field without values → missing", r.data?.data?.flags?.expiry?.includes("missing"));
  assert("combination with a missing placeholder renders empty + missing (D7)", r.data?.data?.values?.document_no?.value === "" && r.data.data.flags.document_no.includes("missing"));
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { values: { batch_no: "BX-77" } });
  assert("glyph outside the subset font → glyph:BX", r.data?.data?.flags?.batch_no?.includes("glyph:BX"), r.data?.data?.flags?.batch_no);
  const product = await prisma.product.create({
    data: { companyId: coA.id, name: "ADD-E120 FORTE", activeIngredients: [{ name: "Vitamin E", concentration: "120000 mg" }, { name: "Sodium selenite", concentration: "75 mg" }] },
  });
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { productId: product.id });
  assert("product fields resolve from the catalogue", r.data?.data?.values?.product_name?.value === "ADD-E120 FORTE" && r.data.data.values.constituent_2_amount.value === "75 mg", r.data?.data?.values);
  assert("… and are rendered", r.data.data.html.includes(">75 mg<") && r.data.data.html.includes(">ADD-E120 FORTE<"));
  const foreign = await prisma.product.create({ data: { companyId: coB.id, name: "B product" } });
  r = await api("GET", "/certificate-products?q=ADD", A);
  assert("certificate product search finds own products", r.status === 200 && r.data.data.products.some((p) => p.id === product.id), r.data);
  r = await api("GET", "/certificate-products", B);
  assert("certificate product search is tenant-forced", r.status === 200 && r.data.data.products.every((p) => p.id !== product.id) && r.data.data.products.some((p) => p.id === foreign.id), r.data);
  r = await api("POST", `/template-versions/${av.id}/preview`, A, { productId: foreign.id });
  assert("another tenant's product → 404", r.status === 404, r.status);

  console.log("\n🧪 Activate, D10 and new versions");
  r = await api("POST", `/template-versions/${av.id}/activate`, A);
  assert("activate ready ADDVET v1 → active", r.status === 200 && r.data.data.status === "active" && !r.data.data.supersededVersionId, r.data);
  r = await api("POST", `/template-versions/${av.id}/new-version`, A);
  assert("new-version → 201 draft v2", r.status === 201 && r.data.data.versionNumber === 2 && r.data.data.status === "draft", r.data);
  const v2 = r.data.data.versionId;
  let v2d = (await api("GET", `/template-versions/${v2}`, A)).data.data.version;
  assert("v2 has v1's design and 8 fields, no geometry", v2d.sanitizedFileId === av.sanitizedFileId && v2d.fields.length === 8 && v2d.fields.every((f) => !f.box) && v2d.basedOnVersionId === av.id);
  const aiDrafts = addDrafts.map((f) => (f.key === "ph_result" ? { ...f, origin: "ai_suggested", confirmed: false } : f));
  r = await api("PUT", `/template-versions/${v2}/fields`, A, { fields: aiDrafts });
  assert("ai_suggested field stored unconfirmed", r.data?.data?.fields?.find((f) => f.key === "ph_result")?.confirmed === false);
  r = await api("PUT", `/template-versions/${v2}/fields`, A, { fields: addDrafts.map((f) => ({ ...f, origin: "manual", confirmed: false })) });
  assert("manual fields can't be stored unconfirmed (D10)", r.data?.data?.fields?.every((f) => f.confirmed));
  r = await api("PUT", `/template-versions/${v2}/fields`, A, { fields: aiDrafts });
  const { v: v2ready } = await prepare(v2);
  assert("v2 prepared → ready", v2ready?.status === "ready", v2ready?.status);
  r = await api("POST", `/template-versions/${v2}/activate`, A);
  assert("activate with an unconfirmed field → 409 FIELDS_UNCONFIRMED", r.status === 409 && r.data?.code === "FIELDS_UNCONFIRMED" && r.data.fields?.[0] === "ph_result", r.data);
  r = await api("POST", `/template-versions/${v2}/fields/confirm`, A, { keys: ["ph_result"] });
  assert("confirm → 200", r.status === 200 && r.data.data.fields.every((f) => f.confirmed), r.data);
  r = await api("POST", `/template-versions/${v2}/activate`, A);
  assert("activate v2 → active, supersedes v1", r.status === 200 && r.data.data.supersededVersionId === av.id, r.data);
  const tpl = (await api("GET", `/certificate-templates/${addvet.data.data.templateId}`, A)).data.data.template;
  assert("template points at v2; v1 superseded", tpl.activeVersionId === v2 && tpl.versions.find((v) => v.id === av.id).status === "superseded");

  console.log("\n🧪 AI suggestions are guarded (GEMINI_DISABLED in tests)");
  r = await api("POST", `/template-versions/${pv.id}/suggest`, A);
  assert("suggest on a non-draft → 409", r.status === 409, r.status);
  const pv2 = (await api("POST", `/template-versions/${pv.id}/new-version`, A)).data.data.versionId;
  r = await api("POST", `/template-versions/${pv2}/suggest`, A);
  assert("suggest with Gemini disabled → 503, no request sent", r.status === 503, r.status + " " + JSON.stringify(r.data));

  console.log("\n🧪 Tenancy: every Phase 2 route is 404 to another company");
  for (const [label, method, url, body] of [
    ["PUT fields", "PUT", `/template-versions/${pv2}/fields`, { fields: pDrafts }],
    ["confirm", "POST", `/template-versions/${v2}/fields/confirm`, { keys: ["ph_result"] }],
    ["suggest", "POST", `/template-versions/${pv2}/suggest`],
    ["prepare", "POST", `/template-versions/${pv2}/prepare`],
    ["prepare-diff", "GET", `/template-versions/${pv.id}/prepare-diff?page=1`],
    ["preview", "POST", `/template-versions/${pv.id}/preview`, { values: {} }],
    ["sample html", "GET", `/template-versions/${pv.id}/html?variant=sample`],
    ["activate", "POST", `/template-versions/${pv.id}/activate`],
    ["new-version", "POST", `/template-versions/${pv.id}/new-version`],
  ]) {
    r = await api(method, url, B, body);
    assert(`${label} → 404`, r.status === 404, r.status);
  }
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
