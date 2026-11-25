// Certificates for several products at once, no invoice (client, path 1 item 4: "generate
// from the templates for several products"). POST /certificates/for-products:
//   dryRun → what would be made per type, and which product has no active template (listed);
//   run    → ONE internal "direct" record with every product, one draft per product per
//            per-product template; batch facts only as typed per product (a product without
//            them gets none — the engine flags the blank, nothing filled in);
//   refused: no product, another company's product, a type with no template at all.
// Needs `npm run dev:test` (cert-renderer + workers).
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const co = await createCompany("f2");
const other = await createCompany("f2b");
const A = asCompany(co.id);

/** upload → fields → prepare → activate (as f1 / p4.generation do) */
async function activeTemplate(label, { file, typeId, brandId, scope }) {
  const up = await uploadTemplate(co.id, { file, name: label, certificateTypeId: typeId, brandId, scope });
  const v = up.version;
  const fields = golden[file].map((g) => {
    const text = v.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  if (r.status !== 200) throw new Error(`fields ${r.status} ${JSON.stringify(r.data)}`);
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  if (task?.status !== "completed") throw new Error(`prepare ${task?.status} ${task?.error}`);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`activate ${r.status} ${JSON.stringify(r.data)}`);
}

try {
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "MAXVET" } });
  const coa = await prisma.certificateType.create({ data: { companyId: co.id, code: "COA", name: "Certificate of Analysis" } });
  const fsc = await prisma.certificateType.create({ data: { companyId: co.id, code: "FSC", name: "Free Sale Certificate" } });
  await activeTemplate("MAXVET COA", { file: "PHARMAVET_COA.pdf", typeId: coa.id, brandId: brand.id });
  const names = ["VITAMAX 1L", "AMINOVITA", "GARLIMYCES"];
  const products = [];
  for (const n of names) products.push(await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: n, producer: "Maxvet Animals Care" } }));
  const foreign = await prisma.product.create({ data: { companyId: other.id, name: "NOT MINE" } });

  console.log("Plan (nothing saved)");
  let r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id, fsc.id], products: products.map((p) => ({ productId: p.id })), dryRun: true });
  const plan = r.data?.data;
  assert("dry run: COA for each of the 3 products; FSC listed as missing for each (no template)", r.status === 200 && plan.planned.filter((p) => p.type === "COA").length === 3 && plan.missing.filter((m) => m.type === "FSC").length === 3 && !plan.missing.some((m) => m.type === "COA"), plan);
  assert("…nothing saved by the plan", (await prisma.invoice.count({ where: { companyId: co.id } })) === 0);

  console.log("\nRefused");
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [] });
  assert("no product → 400", r.status === 400);
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [coa.id], products: [{ productId: foreign.id }] });
  assert("another company's product → 404", r.status === 404, r.data);
  r = await api("POST", "/certificates/for-products", A, { certificateTypeIds: [fsc.id], products: [{ productId: products[0].id }] });
  assert("only a type with no template → 409, saying to make or activate one", r.status === 409 && /make or activate one/.test(r.data.message), r.data);

  console.log("\nGenerate");
  r = await api("POST", "/certificates/for-products", A, {
    certificateTypeIds: [coa.id, fsc.id],
    products: [{ productId: products[0].id, batch: { batchNo: "MX-2611-01", expiryDate: "11/2028" } }, { productId: products[1].id, batch: { batchNo: "MX-2611-02" } }, { productId: products[2].id }],
  });
  const out = r.data?.data;
  assert("3 products → 202, one run, 3 COA planned, FSC still listed as missing", r.status === 202 && out.taskId && out.planned.length === 3 && out.missing.length === 3, r.data);
  const task = await pollTask(out.taskId, A, { timeoutMs: 180_000 });
  const certs = await prisma.certificate.findMany({ where: { companyId: co.id }, include: { invoice: true, items: true } });
  assert("…3 certificate DRAFTS, all on ONE internal direct record", task?.status === "completed" && certs.length === 3 && certs.every((c) => c.status !== "final" && c.invoice.origin === "direct") && new Set(certs.map((c) => c.invoiceId)).size === 1, { task: task?.status, error: task?.error, certs: certs.map((c) => c.status) });
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: out.invoiceId }, orderBy: { lineNo: "asc" } });
  assert("each product's batch facts exactly as typed; the third has none (nothing filled in)", items[0].data.batchNo === "MX-2611-01" && items[0].data.expiryDate === "11/2028" && items[1].data.batchNo === "MX-2611-02" && items[1].data.expiryDate === null && items[2].data.batchNo === null, items.map((i) => i.data));
  const view = await api("GET", `/certificates/${certs.find((c) => c.items?.some((i) => i.invoiceItemId === items[2].id))?.id || certs[0].id}`, A);
  assert("a certificate says it has no invoice", (view.data?.data?.certificate || view.data?.data)?.withoutInvoice === true);
  r = await api("GET", "/invoices?limit=100", A);
  assert("the direct record is not in the invoice list", r.status === 200 && !(r.data.data.invoices || []).some((i) => i.id === out.invoiceId));
} catch (err) {
  assert(`crashed: ${err.message}`, false, err.stack);
} finally {
  await cleanupCompany(co.id).catch((e) => console.error(e.message));
  await cleanupCompany(other.id).catch((e) => console.error(e.message));
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
