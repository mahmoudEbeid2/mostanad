// Certificates V2 — load test (CERTIFICATES_V2_PLAN.md §17 Phase 6: "20 templates,
// invoice with 50 items < 3 min on free-tier RPM"). Not part of `npm test`:
//
//   npm run dev:test            (guarded stack)
//   node tests/load/certificates.load.mjs
//
// 20 active templates = 4 certificate types × { any, brand, country, brand+country,
// per_invoice } — one golden prepared through the API, the other 19 cloned from it
// (same prepared design, distinct slots), so the selector's specificity rules are
// exercised at full width. A 50-line invoice (half brand-A lines, country SA) then
// generates 4 × 50 per-product + 4 collective = 204 certificates.
//
// The budget: extraction is ONE Gemini call per invoice (well inside the free
// tier's 8 RPM) and tests never call Gemini, so it gets a fixed allowance of
// EXTRACTION_ALLOWANCE_S (default 60 s, the slow end of the 20–40 s observed in
// the B2 design brief). Generation must finish within 180 s minus that allowance.
import { api, asCompany, createCompany, cleanupCompany, uploadTemplate, pollTask, fixture, prisma } from "../certificates-v2/helpers.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const BUDGET_S = 180;
const EXTRACTION_ALLOWANCE_S = Number(process.env.EXTRACTION_ALLOWANCE_S || 60);
const LINES = 50;
const co = await createCompany("load");
const A = asCompany(co.id);
let ok = false;

try {
  const t0 = Date.now();
  console.log("Setup: 4 types, 1 golden prepared, 19 clones…");
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "Brand A" } });
  const types = [];
  for (const code of ["COA", "FSC", "HC", "GMP"]) types.push((await api("POST", "/certificate-types", A, { name: `${code} certificate`, code })).data.data.type);
  const up = await uploadTemplate(co.id, { file: "ADDVET_COA.ai", certificateTypeId: types[0].id });
  const v = up.version;
  const field = (key, lineId, sample, source) => {
    const text = v.lines.find((l) => l.id === lineId).text;
    const s = text.indexOf(sample);
    return { key, label: key, lineId, sampleValue: sample, charStart: s, charEnd: s + sample.length, source, required: true, align: "left" };
  };
  const fields = [field("batch_no", "p1-l11", "AVVS1122005", { kind: "item", path: "batchNo" }), field("product_name", "p1-l14", "ADD-E120", { kind: "product", path: "name" })];
  await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  let r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const prep = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  if (prep?.status !== "completed") throw new Error(`prepare: ${prep?.error}`);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`activate: ${JSON.stringify(r.data)}`);
  const golden = await prisma.templateVersion.findUnique({ where: { id: v.id }, include: { fields: true } });
  const variants = [
    { brandId: null, country: null, scope: "per_product" },
    { brandId: brand.id, country: null, scope: "per_product" },
    { brandId: null, country: "SA", scope: "per_product" },
    { brandId: brand.id, country: "SA", scope: "per_product" },
    { brandId: null, country: null, scope: "per_invoice" },
  ];
  let templates = 1;
  for (const type of types) {
    for (const vr of variants) {
      if (type.id === types[0].id && !vr.brandId && !vr.country && vr.scope === "per_product") continue; // the golden itself
      const t = await prisma.certificateTemplate.create({ data: { companyId: co.id, certificateTypeId: type.id, name: `${type.code} ${vr.brandId ? "A" : "-"} ${vr.country || "-"} ${vr.scope}`, ...vr } });
      const { id, templateId, createdAt, updatedAt, fields: fs, ...copy } = golden;
      const tv = await prisma.templateVersion.create({
        data: { ...copy, templateId: t.id, versionNumber: 1, status: "active", pages: copy.pages ?? undefined, lines: copy.lines ?? undefined, fontCoverage: copy.fontCoverage ?? undefined, conversion: copy.conversion ?? undefined, prepareReport: copy.prepareReport ?? undefined },
      });
      await prisma.templateField.createMany({ data: fs.map(({ id: _i, versionId, ...f }) => ({ ...f, versionId: tv.id, source: f.source, format: f.format ?? undefined, box: f.box ?? undefined, limits: f.limits ?? undefined })) });
      await prisma.certificateTemplate.update({ where: { id: t.id }, data: { activeVersionId: tv.id } });
      templates++;
    }
  }
  console.log(`  ${templates} active templates (${((Date.now() - t0) / 1000).toFixed(1)} s setup)`);

  const products = [];
  for (let i = 0; i < LINES; i++) products.push(await prisma.product.create({ data: { companyId: co.id, name: `PRODUCT ${i + 1}`, brandId: i % 2 ? brand.id : null } }));
  const src = await fileStore.putFile({ companyId: co.id, kind: "invoice_source", buffer: fixture("outlined_text.pdf"), mimeType: "application/pdf" });
  const inv = await prisma.invoice.create({ data: { companyId: co.id, country: "SA", status: "ready", sourceFileId: src.id, header: { invoiceNumber: "LOAD-1" }, headerExtracted: {} } });
  await prisma.invoiceItem.createMany({
    data: products.map((p, i) => ({ invoiceId: inv.id, lineNo: i + 1, data: { batchNo: `LB${String(i + 1).padStart(4, "0")}` }, dataExtracted: {}, productId: p.id, matchStatus: "matched", matchMethod: "user" })),
  });

  console.log(`Generate: ${LINES}-line invoice…`);
  const g0 = Date.now();
  r = await api("POST", `/invoices/${inv.id}/generate`, A);
  if (r.status !== 202) throw new Error(`generate: ${JSON.stringify(r.data)}`);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 600_000 });
  const genS = (Date.now() - g0) / 1000;
  const batch = (await api("GET", `/certificate-batches/${r.data.data.batchId}`, A)).data.data.batch;
  const total = genS + EXTRACTION_ALLOWANCE_S;

  console.log(`  task ${task?.status}; batch ${batch.status}: ${batch.counts.rendered}/${batch.counts.planned} rendered, ${batch.counts.failed} failed`);
  console.log(`  generation ${genS.toFixed(1)} s · mean render ${batch.counts.renderMsAvg} ms/certificate · job ${(batch.counts.ms / 1000).toFixed(1)} s`);
  // specificity at scale: every per-product certificate uses a country template (the invoice is SA),
  // brand-A lines the brand+country one, the others the country-only one
  const certs = await prisma.certificate.findMany({ where: { batchId: batch.id }, include: { product: true, templateVersion: { include: { template: true } } } });
  const misrouted = certs.filter((c) => c.scope === "per_product" && (c.templateVersion.template.country !== "SA" || c.templateVersion.template.brandId !== (c.product.brandId || null))).length;
  console.log(`  ${certs.length} certificates; misrouted by the selector: ${misrouted}`);
  console.log(`\nTotal with the ${EXTRACTION_ALLOWANCE_S} s extraction allowance: ${total.toFixed(1)} s (budget ${BUDGET_S} s)`);
  ok = task?.status === "completed" && batch.status === "done" && batch.counts.planned === 4 * LINES + 4 && batch.counts.rendered === batch.counts.planned && misrouted === 0 && total < BUDGET_S;
  console.log(ok ? "✅ LOAD TEST PASSED" : "❌ LOAD TEST FAILED");
} catch (err) {
  console.error("Fatal:", err);
} finally {
  await cleanupCompany(co.id);
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}
