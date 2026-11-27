// 26 Nov production test, CRITICAL: chat → "طلّع شهادة COA لمنتج CALCIUT من غير فاتورة" → the
// draft printed the template's sample product (Batch HSPhar02509001, 09/2025, 09/2028, ANTIBIOTIC,
// 1KG, Doxycycline hyclate 500 mg, pH 2.6) — "COA PHARMAVET (1)" had ONE field marked (Product name),
// everything else was static text. Now:
//   readiness  — every batch / date / result / composition / product-data place is a field or
//                confirmed "static on purpose"; else activation, generation (every path) and
//                finalize are refused with the list and a link to mark them;
//   Express    — the open places become blank fields (flagged on the draft, never printed);
//   guard      — a batch fact / lab result never prints the design's own sample value.
// Unit part: the real production layout (tests/fixtures/pharmavet-coa-version.json, read from prod)
// and the ADDVET COA. E2E part: needs `npm run dev:test`.
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";
import { findVariableAreas, areaWords } from "../../src/services/certificates/templates/readinessCheck.js";
import { guardSample, isBlocking } from "../../src/services/certificates/generation/batchService.js";
import { blankOpenAreas } from "../../src/services/intake/expressService.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const prodLayout = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "pharmavet-coa-version.json"), "utf8"));
const addvetLayout = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "addvet-coa-version.json"), "utf8"));
const texts = (r) => r.areas.filter((a) => !a.staticConfirmed).map((a) => a.text);

console.log("Readiness — the production template «COA PHARMAVET (1)» (only Product name marked)");
let r = findVariableAreas(prodLayout.lines, prodLayout.fields);
const found = texts(r);
assert("not ready", r.ready === false);
for (const v of ["HSPhar02509001", "09/2025", "09/2028", "ANTIBIOTIC", "1KG"]) assert(`  finds "${v}"`, found.includes(v), found);
assert("  finds the results table: pH 2.6, Doxycycline hyclate 500 mg, the appearance, the assay", found.some((t) => /2\.6/.test(t)) && found.some((t) => /Doxycycline hyclate 500 mg/.test(t)) && found.some((t) => /Light yellow crystalline powder/.test(t)) && found.some((t) => /102\.0%/.test(t)), found);
assert("  test names stay (Appearance, pH, Assay are not areas)", !found.some((t) => /^(Appearance|pH|Assay)\b/.test(t)), found);
assert("  the same-on-every-certificate text is not flagged (address, ORIGIN TURKEY, storage, the certify sentence, the producer row)", !found.some((t) => /TURKEY|STORE IN|Zafer|certify|PRODUCER|PHARMAVET İÇ/i.test(t)), found);
assert("  the marked Product name and its glued brand prefix are not areas", !found.some((t) => /DOXYPHARMA|^PHARMAVET$/.test(t)), found);
const labels = Object.fromEntries(r.areas.map((a) => [a.text, a.label]));
assert("  labelled for the person: Batch number, Expiry date, Manufacturing date, Category, Packaging", labels.HSPhar02509001 === "Batch number" && labels["09/2028"] === "Expiry date" && labels["09/2025"] === "Manufacturing date" && labels.ANTIBIOTIC === "Category" && labels["1KG"] === "Packaging", labels);

const asFields = (layout, areas) => [...layout.fields, ...areas.map((a) => ({ lineId: a.lineId, charStart: a.charStart, charEnd: a.charEnd }))];
const marked = asFields(prodLayout, r.areas.filter((a) => a.kind !== "value"));
let r2 = findVariableAreas(prodLayout.lines, marked);
assert("batch / dates / quantities / results marked → only Category left", !r2.ready && texts(r2).join("|") === "ANTIBIOTIC", texts(r2));
r2 = findVariableAreas(prodLayout.lines, marked, { confirmed: r2.areas.map((a) => a.id) });
assert("…confirmed static on purpose → ready", r2.ready === true);
assert("everything marked → ready", findVariableAreas(prodLayout.lines, asFields(prodLayout, r.areas)).ready === true);

console.log("\nReadiness — ADDVET COA (inline 'Label: value' layout)");
r = findVariableAreas(addvetLayout.lines, addvetLayout.fields);
const af = texts(r);
assert("its marked fields (batch, product, expiry, pH result, producer) are not areas", !af.some((t) => /^(AVVS1122005|ADD-E120|11\/2025|4\.0|AFAQ Additives Feed Company)$/.test(t)), af);
for (const v of ["COAAVVS1122005", "05/02/2023", "11/2022", "564 KG", "SUPPLEMENT", "1L", "120000 mg", "60 mg", "Sodium selenite"]) assert(`  finds "${v}"`, af.includes(v), af);
assert("  Origin: JORDAN stays (static label)", !af.some((t) => /JORDAN|Origin/i.test(t)), af);

console.log("\nThe sample guard");
const batchField = { key: "batch_no", label: "Batch number", sampleValue: "HSPhar02509001", required: true, source: { kind: "static", text: "HSPhar02509001" } };
let g = guardSample(batchField, { value: "HSPhar02509001", resolved: "HSPhar02509001", flags: [] });
assert("a batch field whose source is fixed text → blank, flagged sample_value + missing (blocking)", g.value === "" && g.flags.includes("sample_value") && g.flags.includes("missing") && isBlocking("sample_value"), g);
g = guardSample({ ...batchField, source: { kind: "item", path: "batchNo" } }, { value: "hsphar02509001", flags: [] });
assert("a value identical to the design's sample (any case) → blank and flagged", g.value === "" && g.flags.includes("sample_value"));
g = guardSample({ ...batchField, source: { kind: "item", path: "batchNo" } }, { value: "CAL-2611", flags: [] });
assert("the invoice's own batch → printed", g.value === "CAL-2611" && !g.flags.length);
g = guardSample({ key: "product_name", label: "Product name", sampleValue: "DOXYPHARMA", source: { kind: "product", path: "name" } }, { value: "DOXYPHARMA", flags: [] });
assert("not a batch fact / lab result (product name) → untouched", g.value === "DOXYPHARMA");

// ── E2E: the CALCIUT case on the real design ─────────────────────────────────
const co = await createCompany("rdy");
const A = asCompany(co.id);
try {
  const coa = await prisma.certificateType.create({ data: { companyId: co.id, code: "COA", name: "Certificate of Analysis" } });
  const calciut = await prisma.product.create({ data: { companyId: co.id, name: "CALCIUT" } });
  const up = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name: "COA PHARMAVET (1)", certificateTypeId: coa.id });
  const v = up.version;
  const line = v.lines.find((l) => l.text.includes("DOXYPHARMA"));
  const s = line.text.indexOf("DOXYPHARMA");
  const productName = { key: "product_name", label: "Product name", lineId: line.id, charStart: s, charEnd: s + 10, sampleValue: "DOXYPHARMA", source: { kind: "product", path: "name" }, required: true };
  let x = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: [productName] });
  assert("\nE2E: the production state — only Product name marked", x.status === 200, x.data);
  x = await api("GET", `/template-versions/${v.id}/readiness`, A);
  const rd = x.data?.data;
  assert("GET readiness → not ready, the list in Arabic and a link to mark them", x.status === 200 && rd.ready === false && /أماكن متغيرة مش متحددة/.test(rd.message) && /Batch number/.test(rd.message) && /جدول النتائج/.test(rd.message) && rd.link.endsWith(`/versions/${v.id}`), rd);
  x = await api("POST", `/template-versions/${v.id}/prepare`, A);
  await pollTask(x.data.data.taskId, A, { timeoutMs: 120_000 });
  x = await api("POST", `/template-versions/${v.id}/activate`, A);
  assert("activation refused: TEMPLATE_NOT_READY with the places", x.status === 409 && x.data?.code === "TEMPLATE_NOT_READY" && x.data.areas?.some((a) => a.text === "HSPhar02509001"), x.data);

  // a template activated before this rule (production): generation and finalize refuse it
  await prisma.$transaction([prisma.templateVersion.update({ where: { id: v.id }, data: { status: "active" } }), prisma.certificateTemplate.update({ where: { id: up.data.data.templateId }, data: { activeVersionId: v.id } })]);
  x = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: calciut.id }] });
  assert("CALCIUT from «COA PHARMAVET (1)» → generation refused with the list (no draft made)", x.status === 409 && x.data?.code === "TEMPLATE_NOT_READY" && /COA PHARMAVET \(1\)/.test(x.data.message) && (await prisma.certificate.count({ where: { companyId: co.id } })) === 0, x.data);

  // the person marks batch / dates / results / composition (and the product data) as fields
  await prisma.$transaction([prisma.certificateTemplate.update({ where: { id: up.data.data.templateId }, data: { activeVersionId: null } }), prisma.templateVersion.update({ where: { id: v.id }, data: { status: "draft" } })]);
  const extra = rd.areas.flatMap(areaWords).map((a, i) => ({ key: `f_${a.kind}_${i}`, label: a.label, lineId: a.lineId, charStart: a.charStart, charEnd: a.charEnd, sampleValue: a.text, source: { kind: "manual" }, required: true, isBatchFact: a.kind === "batch" || a.kind === "date" ? true : undefined, isLabResult: a.kind === "result" ? true : undefined }));
  x = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: [productName, ...extra] });
  assert("every place marked as a field", x.status === 200, x.data);
  x = await api("GET", `/template-versions/${v.id}/readiness`, A);
  assert("→ ready", x.data?.data?.ready === true, x.data?.data);
  x = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const prep = await pollTask(x.data.data.taskId, A, { timeoutMs: 180_000 });
  x = await api("POST", `/template-versions/${v.id}/activate`, A);
  const pv = await prisma.templateVersion.findUnique({ where: { id: v.id }, select: { error: true, prepareReport: true } });
  assert("prepared and activated", prep?.status === "completed" && x.status === 200, { act: x.data, prep: prep?.result, error: pv.error, failing: (pv.prepareReport?.checks || []).filter((c) => !c.passed) });
  x = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: calciut.id }] });
  assert("CALCIUT → generated", x.status === 202 || x.status === 200, x.data);
  await pollTask(x.data?.data?.taskId, A, { timeoutMs: 180_000 });
  const cert = await prisma.certificate.findFirst({ where: { companyId: co.id, productId: calciut.id }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  const vals = cert?.versions[0]?.values || {};
  const html = cert?.versions[0]?.htmlFileId ? (await prisma.storedFile.findUnique({ where: { id: cert.versions[0].htmlFileId } })) && (await (await import("../../src/services/certificates/storage/fileStore.js")).readText(cert.versions[0].htmlFileId)) : "";
  const blanks = Object.entries(vals).filter(([k]) => k !== "product_name");
  // (28 Nov: on a COA a result nobody gave is taken off with its row — row_removed — never printed blank)
  assert("the draft: Product name CALCIUT; every batch / date blank and flagged missing, every result's row taken off", vals.product_name?.value === "CALCIUT" && blanks.length === extra.length && blanks.every(([, x]) => x.value === "" && ((x.flags || []).includes("missing") || (x.flags || []).includes("row_removed"))) && blanks.some(([, x]) => (x.flags || []).includes("row_removed")), Object.fromEntries(blanks.map(([k, x]) => [k, `${x.value}|${(x.flags || []).join(",")}`])));
  const samples = ["HSPhar02509001", "09/2028", "09/2025", "ANTIBIOTIC", "Doxycycline", "2.6", "102.0%", "1KG"];
  const shown = String(html || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  assert("…and none of the sample product's values is printed on it", shown.length > 100 && samples.every((t) => !new RegExp(`(^|[^\d.])${t.replace(/[.]/g, "\.")}(?![\d])`).test(shown)), samples.filter((t) => shown.includes(t)));
  x = await api("POST", `/certificates/${cert.id}/finalize`, A, { expectedVersion: cert.currentVersion });
  assert("finalize refused while those are blank", x.status === 409 && x.data?.code === "CERTIFICATE_FLAGGED", x.data);

  console.log("\nExpress: open places become blank fields before prepare");
  const up2 = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name: "Express COA", certificateTypeId: coa.id, country: "OM" });
  if (!up2.version) throw new Error(`upload ${up2.status} ${JSON.stringify(up2.data)}`);
  await api("PUT", `/template-versions/${up2.version.id}/fields`, A, { fields: [{ ...productName, lineId: up2.version.lines.find((l) => l.text.includes("DOXYPHARMA")).id }] });
  const added = await blankOpenAreas(up2.version.id, co.id);
  const f2 = await prisma.templateField.findMany({ where: { versionId: up2.version.id } });
  x = await api("GET", `/template-versions/${up2.version.id}/readiness`, A);
  assert("each open place → a blank field (manual, required, unconfirmed; batch/dates batch facts, results lab results) → ready", added >= 10 && f2.filter((f) => f.key.startsWith("blank_")).every((f) => f.source.kind === "manual" && f.required && !f.confirmed) && f2.some((f) => f.isBatchFact && f.sampleValue === "HSPhar02509001") && f2.some((f) => f.isLabResult && /2\.6/.test(f.sampleValue)) && x.data?.data?.ready === true, { added, ready: x.data?.data });
  assert("running it again adds nothing", (await blankOpenAreas(up2.version.id, co.id)) === 0);

  console.log("\nStatic on purpose");
  const up3 = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name: "Static COA", certificateTypeId: coa.id, country: "JO" });
  x = await api("GET", `/template-versions/${up3.version.id}/readiness`, A);
  const open = x.data.data.areas;
  x = await api("POST", `/template-versions/${up3.version.id}/static-areas`, A, { ids: ["p9-l99:0-3"] });
  assert("an id that isn't one of its places → 422", x.status === 422);
  x = await api("POST", `/template-versions/${up3.version.id}/static-areas`, A, { ids: open.map((a) => a.id) });
  const stored = await prisma.templateVersion.findUnique({ where: { id: up3.version.id }, select: { staticAreas: true } });
  assert("confirm all → ready; who and when kept per place", x.status === 200 && x.data.data.ready === true && stored.staticAreas.length === open.length && stored.staticAreas.every((s) => s.at && s.text), x.data);
  x = await api("POST", `/template-versions/${up3.version.id}/static-areas`, A, { ids: [open[0].id], static: false });
  assert("take one back → not ready again", x.status === 200 && x.data.data.ready === false && x.data.data.open === 1);
} catch (err) {
  assert(`no crash: ${err.stack}`, false);
} finally {
  await cleanupCompany(co.id);
  await prisma.$disconnect();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}
