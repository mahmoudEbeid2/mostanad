// Certificate types per invoice (mockups D1, D2). An invoice makes either every type with an
// active template (certificateTypeIds null, also types activated later) or only the chosen ones;
// the plan, the data check and Generate all follow that choice.
// Proven here:
//  - selector: null = all, an array = only those, gaps only for chosen types, the choice frozen in the plan
//  - GET /certificate-types: active templates, scopes, the company default
//  - upload: no choice = null, company default, repeated field, JSON string, explicit null, saveAsDefault
//  - invalid and other-company ids refused; empty refused
//  - PATCH: a confirmed invoice stays confirmed; locked once generated; plan `types` for every usable type
//  - data check and Generate read the same plan; the batch stores the choice
// Needs the guarded stack (npm run dev:test:light).
import { api, asCompany, form, fixture, makeAssert, finish, createCompany, cleanupCompany, pollTask, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { selectTemplates } from "../../src/services/certificates/generation/templateSelector.js";
import { closeQueues } from "../../src/services/certificates/jobs/queues.js";

const { assert, counts } = makeAssert();
const coA = await createCompany("d1a");
const coB = await createCompany("d1b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const field = { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, required: true, category: "product_data" };
const pdf = () => ({ field: "invoice", buffer: fixture("outlined_text.pdf"), name: "inv.pdf", type: "application/pdf" });
const upload = (headers, fields = {}) => {
  const fd = form({ extract: "false" }, pdf());
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return api("POST", "/invoices", headers, fd);
};
const stored = (id) => prisma.invoice.findUnique({ where: { id } });

try {
  console.log("\n🧪 Selector (pure)");
  const T = (id, type, o = {}) => ({ id, name: id, certificateTypeId: type, certificateType: { code: type, name: type }, brandId: null, country: null, scope: "per_product", activeVersionId: `${id}-v`, ...o });
  const line = { id: "it1", lineNo: 1, matchStatus: "matched", productId: "p1", product: { id: "p1", name: "P", brandId: null }, data: {} };
  const templates = [T("coa", "COA"), T("fsc", "FSC"), T("sa", "HC", { country: "SA" })];
  const codes = (p) => [...new Set(p.entries.map((e) => e.typeCode))].sort().join();
  let plan = selectTemplates({ invoice: { country: "EG", certificateTypeIds: null }, items: [line], templates });
  assert("null: every type", codes(plan) === "COA,FSC" && plan.certificateTypeIds === null, plan.entries);
  assert("null: the gap of an unfitting type is reported", plan.gaps.map((g) => g.typeCode).join() === "HC", plan.gaps);
  plan = selectTemplates({ invoice: { country: "EG" }, items: [line], templates });
  assert("no field at all behaves as null", codes(plan) === "COA,FSC");
  plan = selectTemplates({ invoice: { country: "EG", certificateTypeIds: ["FSC"] }, items: [line], templates });
  assert("an array: only those types", codes(plan) === "FSC" && plan.certificateTypeIds.join() === "FSC");
  assert("gaps only for chosen types", plan.gaps.length === 0, plan.gaps);
  plan = selectTemplates({ invoice: { country: "EG", certificateTypeIds: ["HC"] }, items: [line], templates });
  assert("a chosen type no template fits: a gap, and the line gets nothing", plan.entries.length === 0 && plan.gaps.length === 1 && plan.unassigned.length === 1, plan);

  console.log("\n🧪 GET /certificate-types for the picker");
  const coa = await seedTemplate(coA.id, { typeName: "Certificate of Analysis", typeCode: "COA", scope: "per_product", name: "COA any", fields: [field] });
  const fsc = await seedTemplate(coA.id, { typeName: "Free Sale Certificate", typeCode: "FSC", scope: "per_invoice", name: "FSC", fields: [{ key: "company", label: "Company", source: { kind: "company", path: "name" } }] });
  const hc = await seedTemplate(coA.id, { typeName: "Health Certificate", typeCode: "HC", scope: "per_product", name: "HC", fields: [field] });
  const gmp = await prisma.certificateType.create({ data: { companyId: coA.id, name: "GMP Certificate", code: "GMP" } });
  await prisma.certificateTemplate.create({ data: { companyId: coA.id, certificateTypeId: gmp.id, scope: "per_product", name: "GMP draft" } });
  const off = await prisma.certificateType.create({ data: { companyId: coA.id, name: "Off", code: "OFF", isActive: false } });
  const typeB = await prisma.certificateType.create({ data: { companyId: coB.id, name: "B type", code: "BT" } });

  let r = await api("GET", "/certificate-types", A);
  const byCode = Object.fromEntries(r.data.data.types.map((t) => [t.code, t]));
  assert("a type with an active template: count and scope", byCode.COA.activeTemplates === 1 && byCode.COA.scopes.join() === "per_product" && byCode.FSC.scopes.join() === "per_invoice", byCode.COA);
  assert("a draft template doesn't count", byCode.GMP.activeTemplates === 0 && byCode.GMP.scopes.length === 0, byCode.GMP);
  assert("no company default yet: null", r.data.data.defaultCertificateTypeIds === null);

  console.log("\n🧪 Upload");
  r = await upload(A);
  assert("no choice sent → 201", r.status === 201, r.data);
  const inv = r.data.data.invoiceId;
  assert("no choice and no default: null", (await stored(inv)).certificateTypeIds === null);
  r = await upload(A, { certificateTypeIds: [coa.typeId, fsc.typeId] });
  assert("repeated field: an array", r.status === 201 && (await stored(r.data.data.invoiceId)).certificateTypeIds.join() === [coa.typeId, fsc.typeId].join(), r.data);
  r = await upload(A, { certificateTypeIds: [hc.typeId] });
  assert("one repeated value is still an array", r.status === 201 && (await stored(r.data.data.invoiceId)).certificateTypeIds.join() === hc.typeId, r.data);
  r = await upload(A, { certificateTypeIds: JSON.stringify([coa.typeId, coa.typeId]) });
  assert("JSON string, duplicates dropped", r.status === 201 && (await stored(r.data.data.invoiceId)).certificateTypeIds.join() === coa.typeId, r.data);
  r = await upload(A, { certificateTypeIds: "[]" });
  assert("an empty list is refused", r.status === 400 && /at least one/.test(r.data.message), r.data);
  r = await upload(A, { certificateTypeIds: "not json [" });
  assert("garbage is refused", r.status === 400, r.data);
  r = await upload(A, { certificateTypeIds: [typeB.id] });
  assert("another company's type is refused", r.status === 422 && r.data.code === "INVALID_CERTIFICATE_TYPE", r.data);
  r = await upload(A, { certificateTypeIds: [off.id] });
  assert("a switched-off type is refused", r.status === 422 && r.data.code === "INVALID_CERTIFICATE_TYPE", r.data);
  assert("… and nothing was left behind", (await prisma.invoice.count({ where: { companyId: coA.id } })) === 4);

  console.log("\n🧪 Company default");
  r = await upload(A, { certificateTypeIds: [coa.typeId], saveAsDefault: "true" });
  assert("saveAsDefault keeps the sent choice", r.status === 201 && (await prisma.company.findUnique({ where: { id: coA.id } })).defaultCertificateTypeIds.join() === coa.typeId, r.data);
  r = await upload(A);
  assert("an upload without a choice takes the company default", (await stored(r.data.data.invoiceId)).certificateTypeIds.join() === coa.typeId);
  r = await upload(A, { certificateTypeIds: "null" });
  assert("an explicit null beats the default", r.status === 201 && (await stored(r.data.data.invoiceId)).certificateTypeIds === null, r.data);
  r = await api("GET", "/certificate-types", A);
  assert("the picker reads the default", r.data.data.defaultCertificateTypeIds.join() === coa.typeId);
  await prisma.certificateType.update({ where: { id: coa.typeId }, data: { isActive: false } });
  r = await upload(A);
  assert("a default whose types were all switched off = all types", (await stored(r.data.data.invoiceId)).certificateTypeIds === null);
  await prisma.certificateType.update({ where: { id: coa.typeId }, data: { isActive: true } });
  r = await upload(A, { certificateTypeIds: "null", saveAsDefault: "true" });
  assert("saving all + new types clears the default", r.status === 201 && (await prisma.company.findUnique({ where: { id: coA.id } })).defaultCertificateTypeIds === null);
  r = await upload(B);
  assert("another company has its own default", r.status === 201 && (await stored(r.data.data.invoiceId)).certificateTypeIds === null);

  console.log("\n🧪 Plan, data check, Generate follow the choice");
  const p1 = await prisma.product.create({ data: { companyId: coA.id, name: "Vitaminol", storage: "Below 25 C" } });
  const p2 = await prisma.product.create({ data: { companyId: coA.id, name: "Toxinil" } });
  for (const productId of [p1.id, p2.id]) await api("POST", `/invoices/${inv}/items`, A, { data: { name: "line" }, productId });
  const planOf = async (id) => (await api("GET", `/invoices/${id}/generation-plan`, A)).data.data.plan;
  plan = await planOf(inv);
  const planCodes = (p) => [...new Set(p.entries.map((e) => e.typeCode))].sort().join();
  assert("null: all usable types, existing behaviour", planCodes(plan) === "COA,FSC,HC" && plan.entries.length === 5, plan.entries.length);
  const count = (p, code) => p.types.find((t) => t.typeCode === code);
  assert("types: every usable type with what it would make", count(plan, "COA").count === 2 && count(plan, "FSC").count === 1 && count(plan, "FSC").scopes.join() === "per_invoice" && !plan.types.some((t) => t.typeCode === "GMP"), plan.types);

  let check = (await api("POST", `/invoices/${inv}/data-needs`, A, { ai: false })).data.data.check;
  assert("data check: 5 certificates", check.summary.certificates === 5, check.summary);
  const missingAll = check.summary.missing;

  r = await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [coa.typeId] });
  assert("PATCH keeps the choice", r.status === 200 && r.data.data.invoice.certificateTypeIds.join() === coa.typeId, r.data);
  plan = await planOf(inv);
  assert("plan: only COA", planCodes(plan) === "COA" && plan.entries.length === 2);
  assert("types: the others still say what they would make, not selected", count(plan, "HC").count === 2 && count(plan, "HC").selected === false && count(plan, "COA").selected === true, plan.types);
  const got = (await api("GET", `/invoices/${inv}/data-needs`, A)).data.data.check;
  assert("data check (read): only the chosen type's certificates", got.certificates.length === 2 && got.certificates.every((c) => c.typeCode === "COA"), got.certificates.map((c) => c.typeCode));
  check = (await api("POST", `/invoices/${inv}/data-needs`, A, { ai: false })).data.data.check;
  assert("data check: only COA needs, HC's are gone", check.summary.certificates === 2 && check.summary.missing < missingAll && check.summary.missing === 1, check.summary);
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: inv } });
  assert("no row of an unchosen type stays", needs.every((n) => n.templateVersionId === coa.versionId), needs.length);

  r = await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [typeB.id] });
  assert("PATCH: another company's type refused", r.status === 422, r.data);
  r = await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [] });
  assert("PATCH: empty refused", r.status === 400, r.data);
  r = await api("PATCH", `/invoices/${inv}`, B, { certificateTypeIds: [typeB.id] });
  assert("PATCH: another company's invoice is 404", r.status === 404, r.data);

  r = await api("POST", `/invoices/${inv}/confirm`, A);
  assert("confirmed", r.data.data.invoice.status === "ready");
  r = await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: null });
  assert("ready: still editable, stays ready", r.status === 200 && r.data.data.invoice.status === "ready" && r.data.data.invoice.certificateTypeIds === null, r.data);
  assert("null again: back to all", planCodes(await planOf(inv)) === "COA,FSC,HC");
  r = await api("PATCH", `/invoices/${inv}`, A, { country: "SA" });
  assert("any other edit still sends it back to review", r.data.data.invoice.status === "review", r.data);
  await api("POST", `/invoices/${inv}/confirm`, A);

  await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [fsc.typeId] });
  r = await api("POST", `/invoices/${inv}/generate`, A);
  assert("Generate makes only the chosen type", r.status === 202 && r.data.data.planned === 1, r.data);
  const batch = await prisma.certificateBatch.findUnique({ where: { id: r.data.data.batchId } });
  assert("the frozen plan stores the choice", batch.plan.certificateTypeIds.join() === fsc.typeId && batch.plan.entries.every((e) => e.typeCode === "FSC"), batch.plan.certificateTypeIds);
  assert("… and the certificates are only that type", (await prisma.certificate.findMany({ where: { batchId: batch.id } })).every((c) => c.certificateTypeId === fsc.typeId));
  await pollTask(r.data.data.taskId, A);

  console.log("\n🧪 Locked once generated");
  const current = await stored(inv);
  assert("the job finished", ["generated", "partially_failed", "ready"].includes(current.status), current.status);
  await prisma.invoice.update({ where: { id: inv }, data: { status: "generated" } });
  r = await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [coa.typeId] });
  assert("PATCH refused after generation", r.status === 409 && r.data.code === "INVOICE_NOT_EDITABLE", r.data);
  assert("… the choice stays", (await stored(inv)).certificateTypeIds.join() === fsc.typeId);
} catch (err) {
  assert(`unexpected error: ${err.message}`, false, err.stack);
} finally {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
  await closeQueues();
}
await finish(counts);
