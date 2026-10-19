// Certificates V2 Phase 4 — Generation (CERTIFICATES_V2_PLAN.md §10, §17 row 4).
// Exit criterion: invoice → the correct set of certificates with the correct
// values and flags. Real templates (both goldens, prepared + activated through
// the API), real renders in the render worker.
//  - plan preview: per (type, scope) selection, country specificity, brand gaps
//  - generate → batch → certificates: values from item / product / invoice /
//    company / template sources, formats, `missing` flags, flagCount
//  - one certificate per invoice LINE (I15), per_invoice grouping
//  - one certificate failing never stops the batch (partially_failed)
//  - idempotency of the job; regenerate = a new batch
//  - tenancy: every new route is 404 to another company
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";
import { runGenerateBatch } from "../../src/services/certificates/generation/batchService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("p4a");
const coB = await createCompany("p4b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const drafts = (name, lines, pickKeys = null, override = {}) =>
  golden[name]
    .filter((g) => !pickKeys || pickKeys.includes(g.key))
    .map((g) => {
      const text = lines.find((l) => l.id === g.lineId).text;
      const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
      const { occurrence, ...rest } = g;
      return { ...rest, ...(override[g.key] || {}), charStart: start, charEnd: start + g.sampleValue.length, required: true };
    });

/** upload → fields → prepare → activate; → { templateId, versionId } */
async function activeTemplate(label, { file, typeId, scope = "per_product", country, brandId, keys = null, override = {} }) {
  const up = await uploadTemplate(coA.id, { file, name: label, certificateTypeId: typeId, scope, country, brandId });
  const v = up.version;
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: drafts(file, v.lines, keys, override) });
  if (r.status !== 200) throw new Error(`${label}: fields ${r.status} ${JSON.stringify(r.data)}`);
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  if (task?.status !== "completed") throw new Error(`${label}: prepare ${task?.status} ${task?.error}`);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`${label}: activate ${r.status} ${JSON.stringify(r.data)}`);
  return { templateId: up.data.data.templateId, versionId: v.id };
}

const iso = (raw, isoValue) => ({ raw, iso: isoValue });

async function readyInvoice(companyId, { country = null, brandId = null, header, lines }) {
  const src = await fileStore.putFile({ companyId, kind: "invoice_source", buffer: fs.readFileSync(path.join(FIXTURES, "outlined_text.pdf")), mimeType: "application/pdf" });
  const inv = await prisma.invoice.create({ data: { companyId, country, brandId, status: "ready", sourceFileId: src.id, header, headerExtracted: header, extraction: { modelId: "test", promptHash: "test" } } });
  for (const [i, l] of lines.entries()) {
    await prisma.invoiceItem.create({
      data: { invoiceId: inv.id, lineNo: i + 1, data: l.data, dataExtracted: l.data, productId: l.productId || null, matchStatus: l.status || (l.productId ? "matched" : "needs_match"), matchMethod: l.productId ? "user" : null },
    });
  }
  return prisma.invoice.findUnique({ where: { id: inv.id }, include: { items: { orderBy: { lineNo: "asc" } } } });
}

async function generate(invoiceId, headers = A) {
  const r = await api("POST", `/invoices/${invoiceId}/generate`, headers);
  if (r.status !== 202) return { r };
  const task = await pollTask(r.data.data.taskId, headers, { timeoutMs: 180_000 });
  const batch = (await api("GET", `/certificate-batches/${r.data.data.batchId}`, headers)).data?.data?.batch;
  return { r, task, batch };
}

try {
  console.log("\n🧪 Setup: 4 active templates from the goldens");
  let r = await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" });
  const coa = r.data.data.type.id;
  r = await api("POST", "/certificate-types", A, { name: "Free Sale Certificate", code: "FSC" });
  const fsc = r.data.data.type.id;
  r = await api("POST", "/certificate-types", A, { name: "Health Certificate", code: "HC" });
  const hc = r.data.data.type.id;
  const brandA = await prisma.brand.create({ data: { companyId: coA.id, name: "ADDvet" } });

  const coaAny = await activeTemplate("ADDVET COA", { file: "ADDVET_COA.ai", typeId: coa });
  const coaTR = await activeTemplate("PHARMAVET COA TR", { file: "PHARMAVET_COA.pdf", typeId: coa, country: "TR" });
  // collective: invoice-level fields only (assumption A1)
  const fscAll = await activeTemplate("ADDVET FSC", {
    file: "ADDVET_COA.ai",
    typeId: fsc,
    scope: "per_invoice",
    keys: ["document_no", "product_name"],
    override: { document_no: { source: { kind: "invoice", path: "invoiceNumber" } }, product_name: { source: { kind: "company", path: "name" } } },
  });
  const hcBrand = await activeTemplate("ADDVET HC", { file: "ADDVET_COA.ai", typeId: hc, brandId: brandA.id, keys: ["batch_no", "product_name"] });
  assert("4 templates active", [coaAny, coaTR, fscAll, hcBrand].every((t) => t.versionId));

  const p1 = await prisma.product.create({
    data: { companyId: coA.id, brandId: brandA.id, name: "ADD-E120", productCode: "AE120", activeIngredients: [{ name: "Vitamin E", concentration: "120 g" }, { name: "Sodium selenite", concentration: "60 mg" }] },
  });
  const p2 = await prisma.product.create({ data: { companyId: coA.id, name: "ADD ZINC" } });
  const header = { invoiceNumber: "INV-2026-0142", invoiceDate: iso("12/10/2026", "2026-10-12"), customerName: "Gulf Animal Health LLC", customerCountry: "SA", currency: "USD" };
  const inv = await readyInvoice(coA.id, {
    country: "SA",
    header,
    lines: [
      { productId: p1.id, data: { name: "ADD-E120 1L", batchNo: "AVVS1124011", productionDate: iso("06/2024", "2024-06"), expiryDate: iso("06/2027", "2027-06") } },
      { productId: p1.id, data: { name: "ADD-E120 1L", batchNo: "AVVS1124012", productionDate: iso("07/2024", "2024-07"), expiryDate: iso("07/2027", "2027-07") } },
      { productId: p2.id, data: { name: "ADD ZINC", batchNo: "ZN0001", productionDate: iso("03/04/2025", null), expiryDate: iso("2027-01-31", "2027-01-31") } },
      { productId: p2.id, status: "ignored", data: { name: "Sample, no charge", batchNo: "S1" } },
    ],
  });
  const [l1, l2, l3, l4] = inv.items;

  console.log("\n🧪 Plan preview");
  r = await api("GET", `/invoices/${inv.id}/generation-plan`, A);
  const plan = r.data?.data?.plan;
  assert("plan → 200", r.status === 200, r.data);
  const byType = (code) => plan.entries.filter((e) => e.typeCode === code);
  assert("COA: one per matched line (3), the countryless golden for SA", byType("COA").length === 3 && byType("COA").every((e) => e.templateId === coaAny.templateId), byType("COA"));
  assert("same product on lines 1 and 2 → two COAs (I15)", byType("COA").filter((e) => e.productId === p1.id).length === 2);
  assert("FSC: one collective certificate for lines 1–3", byType("FSC").length === 1 && byType("FSC")[0].lineNos.join() === "1,2,3" && byType("FSC")[0].productId === null);
  assert("HC: only the brand-A lines (1, 2)", byType("HC").map((e) => e.lineNos[0]).join() === "1,2");
  assert("gap: line 3 has no HC template for its brand", plan.gaps.length === 1 && plan.gaps[0].lineNo === 3 && plan.gaps[0].typeCode === "HC", plan.gaps);
  assert("ignored line 4 is nowhere; nothing unassigned", !plan.entries.some((e) => e.invoiceItemIds.includes(l4.id)) && plan.unassigned.length === 0);
  const trInv = await readyInvoice(coA.id, { country: "TR", header: { invoiceNumber: "TR-1" }, lines: [{ productId: p2.id, data: { batchNo: "T1" } }] });
  r = await api("GET", `/invoices/${trInv.id}/generation-plan`, A);
  assert("country TR → the TR template beats the countryless one", r.data?.data?.plan?.entries.find((e) => e.typeCode === "COA")?.templateId === coaTR.templateId);

  console.log("\n🧪 Generate guards");
  const reviewInv = await readyInvoice(coA.id, { header: { invoiceNumber: "R-1" }, lines: [{ productId: p2.id, data: {} }] });
  await prisma.invoice.update({ where: { id: reviewInv.id }, data: { status: "review" } });
  r = await api("POST", `/invoices/${reviewInv.id}/generate`, A);
  assert("an invoice under review cannot be generated → 409 INVOICE_NOT_READY", r.status === 409 && r.data?.code === "INVOICE_NOT_READY", r.data);
  const bInv = await readyInvoice(coB.id, { header: { invoiceNumber: "B-1" }, lines: [{ productId: (await prisma.product.create({ data: { companyId: coB.id, name: "B product" } })).id, data: {} }] });
  r = await api("POST", `/invoices/${bInv.id}/generate`, B);
  assert("no applicable template → 409 NOTHING_TO_GENERATE (lists the lines)", r.status === 409 && r.data?.code === "NOTHING_TO_GENERATE" && r.data.unassigned?.length === 1, r.data);

  console.log("\n🧪 Generate → batch → certificates");
  const g1 = await generate(inv.id);
  assert("generate → 202 { batchId, taskId, planned: 6 }", g1.r.status === 202 && g1.r.data.data.planned === 6, g1.r.data);
  assert("task completed", g1.task?.status === "completed", g1.task?.error);
  assert("batch done: 6 rendered, 0 failed", g1.batch?.status === "done" && g1.batch.counts.rendered === 6 && g1.batch.counts.failed === 0, g1.batch?.counts);
  assert("plan frozen on the batch", g1.batch?.plan?.entries?.length === 6);
  r = await api("GET", `/invoices/${inv.id}`, A);
  assert("invoice → generated, lists the batch", r.data.data.invoice.status === "generated" && r.data.data.invoice.batches[0]?.id === g1.batch.id);

  const certs = g1.batch.certificates;
  const coaFor = (lineNo) => certs.find((c) => c.certificateType.code === "COA" && c.lineNos[0] === lineNo);
  const get = async (c) => (await api("GET", `/certificates/${c.id}`, A)).data?.data?.certificate;
  const c1 = await get(coaFor(1));
  const v = (c, k) => c.values[k]?.value;
  assert("COA line 1: batch from the line", v(c1, "batch_no") === "AVVS1124011");
  assert("COA line 1: product name from the matched product", v(c1, "product_name") === "ADD-E120");
  assert("COA line 1: dates formatted MM/YYYY", v(c1, "expiry") === "06/2027" && v(c1, "production") === "06/2024", c1.values.expiry);
  assert("COA line 1: product relation path (activeIngredients[1])", v(c1, "constituent_2_name") === "Sodium selenite" && v(c1, "constituent_2_amount") === "60 mg");
  assert("COA line 1: template source COA{{item.batchNo}}", v(c1, "document_no") === "COAAVVS1124011");
  assert("COA line 1: manual field empty + flagged missing (D7)", v(c1, "ph_result") === "" && c1.values.ph_result.flags.includes("missing"));
  assert("value shape §10.4 (source, resolved, origin auto)", c1.values.batch_no.source.kind === "item" && c1.values.batch_no.resolved === "AVVS1124011" && c1.values.batch_no.origin === "auto");
  assert("flagCount = blocking flags (only ph_result)", c1.flagCount === 1, c1.flagCount);
  assert("certificate pins its template version, version 1", c1.template.id === coaAny.templateId && c1.currentVersion === 1 && c1.status === "draft");
  const c2 = await get(coaFor(2));
  assert("COA line 2 (same product): its own batch + dates", v(c2, "batch_no") === "AVVS1124012" && v(c2, "expiry") === "07/2027");
  const c3 = await get(coaFor(3));
  assert("COA line 3: missing ingredient → empty + missing", v(c3, "constituent_2_name") === "" && c3.values.constituent_2_name.flags.includes("missing"));
  assert("COA line 3: ambiguous production date → raw kept, flagged format", v(c3, "production") === "03/04/2025" && c3.values.production.flags.includes("format"), c3.values.production);
  assert("COA line 3: full ISO date → MM/YYYY", v(c3, "expiry") === "01/2027");
  const fscCert = await get(certs.find((c) => c.certificateType.code === "FSC"));
  assert("FSC: invoice + company sources", v(fscCert, "document_no") === "INV-2026-0142" && v(fscCert, "product_name") === coA.name && fscCert.values.document_no.flags.length === 0, fscCert.values);
  // the test company's (random) name has "_" (and maybe other letters) the design's subset font lacks (§7.4 step 5, A5)
  assert("FSC: a character missing from the design font → glyph:_ (blocking)", fscCert.values.product_name.flags.some((f) => f.startsWith("glyph:") && f.includes("_")) && fscCert.flagCount === 1, fscCert.values.product_name.flags);
  assert("FSC covers lines 1–3", fscCert.lines.map((l) => l.lineNo).join() === "1,2,3");

  r = await api("GET", `/certificates/${c1.id}/html`, A);
  assert("HTML: static, CSP default-src 'none', nosniff", r.status === 200 && /default-src 'none'/.test(r.headers.get("content-security-policy")) && r.headers.get("x-content-type-options") === "nosniff");
  assert("HTML: the same CSP also as <meta> inside the document (about:blank frames)", r.buffer.toString("utf8").includes(`<meta http-equiv="Content-Security-Policy" content="${r.headers.get("content-security-policy")}">`));
  assert("HTML: contains the values, not the design's sample batch", r.buffer.toString("utf8").includes("AVVS1124011") && r.buffer.toString("utf8").includes("COAAVVS1124011") && !r.buffer.toString("utf8").includes("AVVS1122005"));
  assert("HTML: no script, no contenteditable", !/<script/i.test(r.buffer.toString("utf8")) && !/contenteditable/i.test(r.buffer.toString("utf8")));
  r = await api("GET", `/certificates/${c1.id}/html?version=2`, A);
  assert("a version that doesn't exist → 404", r.status === 404);
  r = await api("GET", `/certificates/${c1.id}/thumbnail`, A);
  assert("thumbnail PNG", r.status === 200 && r.headers.get("content-type") === "image/png");

  console.log("\n🧪 Lists");
  r = await api("GET", `/certificates?invoiceId=${inv.id}`, A);
  assert("list by invoice: 6", r.data?.total === 6, r.data?.total);
  r = await api("GET", `/certificates?invoiceId=${inv.id}&flagged=true`, A);
  assert("flagged filter: the 3 COAs + the FSC (glyph)", r.data?.total === 4, r.data?.total);
  r = await api("GET", `/certificates?q=avvs1124012`, A);
  assert("search by batch", r.data?.total >= 1 && r.data.data.certificates.every((c) => c.batchNo === "AVVS1124012"));
  r = await api("GET", `/invoices?q=0142`, A);
  assert("invoice list: Certificates column counts", r.data?.data?.invoices?.[0]?.certificateCounts?.total === 6, r.data?.data?.invoices?.[0]?.certificateCounts);

  console.log("\n🧪 Idempotency");
  const before = await prisma.certificateVersion.count({ where: { certificate: { batchId: g1.batch.id } } });
  let out = await runGenerateBatch(g1.batch.id);
  assert("re-running a finished batch is a no-op", out.skipped === true);
  await prisma.certificateBatch.update({ where: { id: g1.batch.id }, data: { status: "running" } });
  await prisma.certificate.updateMany({ where: { batchId: g1.batch.id }, data: { status: "pending" } }); // as if the job died mid-way
  out = await runGenerateBatch(g1.batch.id);
  const after = await prisma.certificateVersion.count({ where: { certificate: { batchId: g1.batch.id } } });
  assert("a retried job creates no duplicate certificates or versions", after === before && (await prisma.certificate.count({ where: { batchId: g1.batch.id } })) === 6 && out.rendered === 6, { before, after, out });

  console.log("\n🧪 Regenerate (new batch) with one design broken");
  const hcVersion = await prisma.templateVersion.findUnique({ where: { id: hcBrand.versionId } });
  const hcFile = await prisma.storedFile.findUnique({ where: { id: hcVersion.preparedFileId } });
  fs.renameSync(fileStore.absolutePath(hcFile), fileStore.absolutePath(hcFile) + ".bak");
  const g2 = await generate(inv.id);
  fs.renameSync(fileStore.absolutePath(hcFile) + ".bak", fileStore.absolutePath(hcFile));
  assert("regenerate from `generated` → a new batch", g2.r.status === 202 && g2.batch.id !== g1.batch.id);
  assert("one design failing never stops the batch: partially_failed, 4 rendered, 2 failed", g2.batch.status === "partially_failed" && g2.batch.counts.rendered === 4 && g2.batch.counts.failed === 2, g2.batch.counts);
  assert("the failure is visible on each failed certificate", g2.batch.certificates.filter((c) => c.status === "failed").every((c) => c.certificateType.code === "HC" && /ENOENT|no such file/i.test(c.error)), g2.batch.certificates.map((c) => c.error));
  r = await api("GET", `/invoices/${inv.id}`, A);
  assert("invoice → partially_failed; first batch untouched", r.data.data.invoice.status === "partially_failed" && (await prisma.certificate.count({ where: { batchId: g1.batch.id, status: "draft" } })) === 6);

  console.log("\n🧪 Tenancy: every new route is 404 to another company");
  for (const [label, method, url] of [
    ["generation plan", "GET", `/invoices/${inv.id}/generation-plan`],
    ["generate", "POST", `/invoices/${inv.id}/generate`],
    ["batch", "GET", `/certificate-batches/${g1.batch.id}`],
    ["certificate", "GET", `/certificates/${c1.id}`],
    ["certificate html", "GET", `/certificates/${c1.id}/html`],
    ["certificate thumbnail", "GET", `/certificates/${c1.id}/thumbnail`],
  ]) {
    r = await api(method, url, B);
    assert(`${label} → 404`, r.status === 404, r.status);
  }
  r = await api("GET", "/certificates", B);
  assert("another company's certificate list is empty", r.data?.total === 0);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
