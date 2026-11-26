// 26 Nov production test, Phase 4 — Path 1 dead ends:
//   1 Products → "Make certificates…" for a company with no types / templates offered nothing but
//     "This company has no certificate types yet.": the window now makes a type and turns a dropped
//     certificate file into that type's template (the same API calls are checked here);
//   2 a label stuck on "no rules for this country" never blocks certificate work;
//   3 the plan says, before "Make", which template would be refused as not ready (with its link).
// Needs `npm run dev:test`.
import { prisma, api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, confirmStatic } from "./helpers.js";
import { codeFromFileName } from "../../../mostanad_front/src/utils/certificateTypeFromName.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const co = await createCompany("f5");
const A = asCompany(co.id);

try {
  console.log("The window's type from a file name");
  assert("«ADDVET OMAN COA 10-26.pdf» → COA, «ADDVET HC OMAN» → HC, «Free Sale … .pdf» → FSC", codeFromFileName("ADDVET OMAN COA 10-26.pdf") === "COA" && codeFromFileName("ADDVET HC OMAN 10-26.pdf") === "HC" && codeFromFileName("Free Sale Certificate.pdf") === "FSC");
  assert("a name that says none, or two → asked (null)", codeFromFileName("scan 001.pdf") === null && codeFromFileName("COA and HC.pdf") === null);

  console.log("\n1 · nothing set up → set it up from the window");
  const p = await prisma.product.create({ data: { companyId: co.id, name: "CALCIUT" } });
  let r = await api("GET", "/certificate-types", A);
  assert("the company has no types (the 26 Nov state)", r.status === 200 && (r.data.data.types || []).length === 0, r.data);
  r = await api("POST", "/certificate-types", A, { code: "COA", name: "Certificate of Analysis" });
  const coa = r.data?.data?.type;
  assert("«اعمل نوع شهادة» COA → made", r.status === 201 && coa?.code === "COA", r.data);
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: p.id }], dryRun: true });
  assert("the plan: COA has no template → listed as missing (the window then shows the drop zone)", r.status === 200 && r.data.data.planned.length === 0 && r.data.data.missing.some((m) => m.type === "COA"), r.data);
  const up = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name: "ADDVET OMAN COA 10-26", certificateTypeId: coa.id });
  assert("«ارفع قالب»: the dropped file → a draft COA template", up.status === 202 && up.version?.status === "draft", up.status);

  console.log("\n3 · a template that would be refused is said before «Make»");
  const v = up.version;
  const line = v.lines.find((l) => l.text.includes("DOXYPHARMA"));
  const s = line.text.indexOf("DOXYPHARMA");
  await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: [{ key: "product_name", label: "Product name", lineId: line.id, charStart: s, charEnd: s + 10, sampleValue: "DOXYPHARMA", source: { kind: "product", path: "name" }, required: true }] });
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 180_000 });
  // as production has it: activated before the readiness rule
  await prisma.$transaction([prisma.templateVersion.update({ where: { id: v.id }, data: { status: "active" } }), prisma.certificateTemplate.update({ where: { id: up.data.data.templateId }, data: { activeVersionId: v.id } })]);
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: p.id }], dryRun: true });
  const nr = r.data?.data?.notReady || [];
  assert("the plan names it: COA not ready, the Arabic reason and the link to mark it", r.status === 200 && nr.length === 1 && nr[0].type === "COA" && /أماكن متغيرة/.test(nr[0].message) && nr[0].link.endsWith(`/versions/${v.id}`), r.data);

  console.log("\n2 · «no rules for this country» on a label never blocks certificates");
  await prisma.generatedLabel.create({ data: { companyId: co.id, productId: p.id, inputPayload: {}, labelData: {}, labelProvenance: {}, schemaVersion: "vet-label@1.0.0", country: "Oman", language: "en", status: "failed_validation" } });
  const rules = await prisma.regulatoryDocument.count({ where: { country: { in: ["OM", "Oman", "عمان"] }, status: "approved" } }).catch(() => 0);
  await prisma.$transaction([prisma.certificateTemplate.update({ where: { id: up.data.data.templateId }, data: { activeVersionId: null } }), prisma.templateVersion.update({ where: { id: v.id }, data: { status: "ready" } })]);
  await confirmStatic(v.id, A);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  assert("(the template is marked / confirmed and active)", r.status === 200, r.data);
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: p.id }] });
  await pollTask(r.data?.data?.taskId, A, { timeoutMs: 180_000 });
  const made = await prisma.certificate.count({ where: { companyId: co.id, productId: p.id, status: { in: ["draft", "final"] } } });
  assert(`the product's label failed validation in a country with no rules (${rules} approved) → its COA is still made`, (r.status === 202 || r.status === 200) && made === 1, { status: r.status, data: r.data, made });
} catch (err) {
  assert(`no crash: ${err.stack}`, false);
} finally {
  await prisma.generatedLabel.deleteMany({ where: { companyId: co.id } }).catch(() => {});
  await cleanupCompany(co.id);
  await prisma.$disconnect();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}
