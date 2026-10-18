// Certificates V2 Phase 5 — Edit, export, finalize (CERTIFICATES_V2_PLAN.md §11, §16.2, §17 row 5).
// Exit criteria: the full loop on both goldens; PDF acceptance (§16.2) passes.
//  - PATCH values → new version (optimistic concurrency, 409 VERSION_CONFLICT)
//  - reset a field from its source, versions list, forward-only restore
//  - finalize refused while blocking flags remain; final = frozen (409 CERTIFICATE_FINAL)
//  - duplicate a final certificate as a draft
//  - PDF: 1 page per .pf, page size = source ±0.5 pt, real text, visual diff vs source ≤ 3 % at 100 dpi
//  - batch ZIP; tenancy 404s
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";
import { comparePngs } from "../../src/services/certificates/engine/pixelDiff.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("p5a");
const coB = await createCompany("p5b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const drafts = (name, lines) =>
  golden[name].map((g) => {
    const text = lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });

async function activeTemplate(file, typeId, country) {
  const up = await uploadTemplate(coA.id, { file, name: file, certificateTypeId: typeId, country });
  const v = up.version;
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: drafts(file, v.lines) });
  if (r.status !== 200) throw new Error(`${file}: fields ${r.status} ${JSON.stringify(r.data)}`);
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const t = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  if (t?.status !== "completed") throw new Error(`${file}: prepare ${t?.error}`);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`${file}: activate ${JSON.stringify(r.data)}`);
  return v.id;
}

async function generatedCertificate({ country, product, line }) {
  const src = await fileStore.putFile({ companyId: coA.id, kind: "invoice_source", buffer: fs.readFileSync(path.join(FIXTURES, "outlined_text.pdf")), mimeType: "application/pdf" });
  const inv = await prisma.invoice.create({ data: { companyId: coA.id, country, status: "ready", sourceFileId: src.id, header: { invoiceNumber: `INV-${country || "X"}-1` }, headerExtracted: {} } });
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: line, dataExtracted: line, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  const r = await api("POST", `/invoices/${inv.id}/generate`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  const batch = (await api("GET", `/certificate-batches/${r.data.data.batchId}`, A)).data.data.batch;
  return { invoiceId: inv.id, batchId: batch.id, certId: batch.certificates[0].id };
}

const getCert = async (id) => (await api("GET", `/certificates/${id}`, A)).data?.data?.certificate;

async function pdfInfo(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 100 / 72 });
  const { canvas, context } = doc.canvasFactory.create(Math.round(vp.width), Math.round(vp.height));
  context.fillStyle = "#fff";
  context.fillRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
  return { pages: doc.numPages, size: page.view.slice(2), png: canvas.toBuffer("image/png"), text };
}

async function exportPdf(certId) {
  const r = await api("POST", `/certificates/${certId}/export-pdf`, A);
  const task = await pollTask(r.data?.data?.taskId, A, { timeoutMs: 120_000 });
  const pdf = await api("GET", `/certificates/${certId}/pdf`, A);
  return { r, task, pdf };
}

try {
  console.log("\n🧪 Setup: both goldens active, one generated certificate each");
  const typeId = (await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" })).data.data.type.id;
  await activeTemplate("ADDVET_COA.ai", typeId, null);
  await activeTemplate("PHARMAVET_COA.pdf", typeId, "TR");
  const addProduct = await prisma.product.create({ data: { companyId: coA.id, name: "ADD-E120", activeIngredients: [{ name: "Vitamin E", concentration: "120 g" }, { name: "Sodium selenite", concentration: "60 mg" }] } });
  const pharmaProduct = await prisma.product.create({ data: { companyId: coA.id, name: "PHARMA ORAL", producer: "PHARMAVET", activeIngredients: [{ name: "Amoxicillin", concentration: "450 mg" }] } });
  const add = await generatedCertificate({ country: "SA", product: addProduct, line: { batchNo: "AVVS1124011", productionDate: { raw: "06/2024", iso: "2024-06" }, expiryDate: { raw: "06/2027", iso: "2027-06" } } });
  const pharma = await generatedCertificate({ country: "TR", product: pharmaProduct, line: { batchNo: "HSPhar02601001", productionDate: { raw: "01/2026", iso: "2026-01" }, expiryDate: { raw: "01/2029", iso: "2029-01" } } });
  let c = await getCert(add.certId);
  assert("ADDVET certificate generated: v1, ph_result missing → 1 issue", c?.currentVersion === 1 && c.flagCount === 1 && c.values.ph_result.flags.includes("missing"), c?.flagCount);

  console.log("\n🧪 Edit → new version (optimistic concurrency)");
  let r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 2, changes: { ph_result: "4.2" } });
  assert("stale expectedVersion → 409 VERSION_CONFLICT + currentVersion", r.status === 409 && r.data?.code === "VERSION_CONFLICT" && r.data.currentVersion === 1, r.data);
  r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 1, changes: { nope: "x" } });
  assert("unknown field → 422 UNKNOWN_FIELD", r.status === 422 && r.data?.code === "UNKNOWN_FIELD", r.data);
  r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 1, changes: { ph_result: "4.2" } });
  assert("edit → 200, version 2, no blocking flags", r.status === 200 && r.data.data.version === 2 && r.data.data.flagCount === 0, r.data);
  assert("change summary key: old → new", r.data.data.changeSummary === "ph_result: ∅ → 4.2", r.data.data.changeSummary);
  c = await getCert(add.certId);
  assert("value origin manual, editor recorded", c.values.ph_result.origin === "manual" && c.values.ph_result.value === "4.2" && !!c.values.ph_result.editedAt);
  const html1 = (await api("GET", `/certificates/${add.certId}/html?version=1`, A)).buffer.toString("utf8");
  const html2 = (await api("GET", `/certificates/${add.certId}/html`, A)).buffer.toString("utf8");
  assert("v2 HTML re-rendered on the server; v1 kept as it was", html2 !== html1 && html2.includes("4.2") && (await api("GET", `/certificates/${add.certId}/html?version=1`, A)).status === 200);
  const [p1, p2] = await Promise.all([
    api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 2, changes: { batch_no: "AVVS1124099" } }),
    api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 2, changes: { batch_no: "AVVS1124098" } }),
  ]);
  assert("two concurrent edits of v2: exactly one wins, the other 409", [p1.status, p2.status].sort().join() === "200,409", [p1.status, p2.status]);
  c = await getCert(add.certId);
  assert("now version 3", c.currentVersion === 3);
  r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: 3, changes: { product_name: "ADD-Ωж" } });
  c = await getCert(add.certId);
  assert("a character the design font lacks → glyph flag, counted as an issue", c.currentVersion === 4 && c.values.product_name.flags.some((f) => f.startsWith("glyph:")) && c.flagCount === 1, c.values.product_name);

  console.log("\n🧪 Reset, versions, restore");
  r = await api("POST", `/certificates/${add.certId}/fields/product_name/reset`, A, { expectedVersion: 4 });
  c = await getCert(add.certId);
  assert("reset re-resolves from the source (origin auto), v5, issue gone", r.status === 200 && c.currentVersion === 5 && c.values.product_name.value === "ADD-E120" && c.values.product_name.origin === "auto" && c.flagCount === 0, r.data);
  r = await api("POST", `/certificates/${add.certId}/fields/nope/reset`, A, {});
  assert("reset of an unknown field → 404", r.status === 404);
  r = await api("GET", `/certificates/${add.certId}/versions`, A);
  const versions = r.data?.data?.versions || [];
  assert("versions: 5, newest first, with their change source", versions.map((v) => v.versionNumber).join() === "5,4,3,2,1" && versions.map((v) => v.changeSource).join() === "regenerate_field,user_edit,user_edit,user_edit,generation", versions.map((v) => v.changeSource));
  r = await api("POST", `/certificates/${add.certId}/versions/1/restore`, A, { expectedVersion: 5 });
  c = await getCert(add.certId);
  const vRows = await prisma.certificateVersion.findMany({ where: { certificateId: add.certId }, orderBy: { versionNumber: "asc" } });
  assert("restore v1 → v6 (forward-only), its values and its issue are back", r.status === 200 && c.currentVersion === 6 && c.values.ph_result.value === "" && c.values.batch_no.value === "AVVS1124011" && c.flagCount === 1);
  assert("restored values marked origin restored; v1's render reused", c.values.batch_no.origin === "restored" && vRows[5].htmlFileId === vRows[0].htmlFileId && vRows[5].changeSource === "restore");
  r = await api("POST", `/certificates/${add.certId}/versions/6/restore`, A, {});
  assert("restoring the current version → 409", r.status === 409);

  console.log("\n🧪 Finalize");
  r = await api("POST", `/certificates/${add.certId}/finalize`, A, {});
  assert("finalize with an issue → 409 CERTIFICATE_FLAGGED listing the fields", r.status === 409 && r.data?.code === "CERTIFICATE_FLAGGED" && r.data.flags?.ph_result?.includes("missing"), r.data);

  console.log("\n🧪 PDF acceptance (§16.2) on both goldens — every field set back to the design's own sample");
  for (const [label, cert, file] of [
    ["ADDVET", add.certId, "ADDVET_COA.ai"],
    ["PHARMAVET", pharma.certId, "PHARMAVET_COA.pdf"],
  ]) {
    const cur = await getCert(cert);
    const changes = Object.fromEntries(golden[file].map((g) => [g.key, g.sampleValue]));
    r = await api("PATCH", `/certificates/${cert}/values`, A, { expectedVersion: cur.currentVersion, changes });
    assert(`${label}: sample values → no issues`, r.status === 200 && r.data.data.flagCount === 0, r.data?.data?.flags || r.data);
    const { r: er, task, pdf } = await exportPdf(cert);
    assert(`${label}: export-pdf → 202, job completed`, er.status === 202 && task?.status === "completed", task?.error);
    assert(`${label}: GET pdf → application/pdf, attachment with a meaningful name`, pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" && /attachment; filename="COA-.+\.pdf"/.test(pdf.headers.get("content-disposition")), pdf.headers.get("content-disposition"));
    const out = await pdfInfo(pdf.buffer);
    const src = await pdfInfo(fs.readFileSync(path.join(FIXTURES, file)));
    assert(`${label}: 1 page per .pf`, out.pages === 1, out.pages);
    const dw = Math.abs(out.size[0] - src.size[0]);
    const dh = Math.abs(out.size[1] - src.size[1]);
    assert(`${label}: page size = source ±0.5 pt (Δ ${dw.toFixed(2)} × ${dh.toFixed(2)})`, dw <= 0.5 && dh <= 0.5, { out: out.size, src: src.size });
    assert(`${label}: the text is real and extractable`, out.text.includes(changes.batch_no), out.text.slice(0, 200));
    const diff = await comparePngs(src.png, out.png);
    assert(`${label}: visual diff vs the source ≤ 3 % at 100 dpi (${diff.pct.toFixed(3)} %)`, diff.pct <= 3, diff);
  }

  r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: (await getCert(add.certId)).currentVersion, changes: { batch_no: "AVVS1124011", document_no: "COAAVVS1124011", product_name: "ADD-E120" } });
  const preFinal = await getCert(add.certId);
  r = await api("POST", `/certificates/${add.certId}/finalize`, A, { expectedVersion: preFinal.currentVersion });
  const final = r.data?.data?.certificate;
  assert("finalize → final, who/when recorded, PDF frozen", r.status === 200 && final.status === "final" && !!final.finalizedAt && !!final.finalPdfFileId, r.data);
  const frozenVersion = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: add.certId, versionNumber: preFinal.currentVersion } } });
  assert("the frozen PDF is the current version's PDF (exported on finalize)", frozenVersion.pdfFileId === final.finalPdfFileId);
  r = await api("PATCH", `/certificates/${add.certId}/values`, A, { expectedVersion: final.currentVersion, changes: { ph_result: "4.3" } });
  assert("a final certificate rejects edits → 409 CERTIFICATE_FINAL", r.status === 409 && r.data?.code === "CERTIFICATE_FINAL", r.data);
  for (const [label, url, body] of [
    ["reset", `/certificates/${add.certId}/fields/ph_result/reset`, {}],
    ["restore", `/certificates/${add.certId}/versions/1/restore`, {}],
    ["finalize again", `/certificates/${add.certId}/finalize`, {}],
  ]) {
    r = await api("POST", url, A, body);
    assert(`${label} on a final certificate → 409 CERTIFICATE_FINAL`, r.status === 409 && r.data?.code === "CERTIFICATE_FINAL", r.data);
  }
  const finalPdf = await api("GET", `/certificates/${add.certId}/pdf`, A);
  assert("GET pdf of a final certificate = the frozen file", finalPdf.status === 200 && finalPdf.buffer.equals((await fileStore.readFile(final.finalPdfFileId)).buffer));

  console.log("\n🧪 Duplicate");
  r = await api("POST", `/certificates/${add.certId}/duplicate`, A);
  const dupId = r.data?.data?.certificateId;
  const dup = dupId && (await getCert(dupId));
  assert("duplicate a final certificate → a new draft v1 with the same values", r.status === 201 && dup.status === "draft" && dup.currentVersion === 1 && dup.values.ph_result.value === "4.0" && dup.batchId === add.batchId);
  r = await api("PATCH", `/certificates/${dupId}/values`, A, { expectedVersion: 1, changes: { ph_result: "4.4" } });
  assert("the duplicate is editable; the original stays final", r.status === 200 && (await getCert(add.certId)).status === "final");

  console.log("\n🧪 Batch ZIP");
  r = await api("POST", `/certificate-batches/${add.batchId}/export`, A);
  const zt = await pollTask(r.data?.data?.taskId, A, { timeoutMs: 120_000 });
  assert("export batch → 202, job completed", r.status === 202 && zt?.status === "completed", zt?.error);
  r = await api("GET", `/certificate-batches/${add.batchId}/zip`, A);
  const zip = await JSZip.loadAsync(r.buffer);
  const names = Object.keys(zip.files);
  assert("ZIP: one PDF per certificate, unique names", r.headers.get("content-type") === "application/zip" && names.length === 2 && new Set(names).size === 2 && names.every((n) => /^COA-ADD-E120-AVVS1124011(-2)?\.pdf$/.test(n)), names);
  const firstPdf = await zip.file(names.find((n) => !n.includes("-2.pdf"))).async("nodebuffer");
  assert("ZIP: the final certificate's entry is its frozen PDF", firstPdf.equals(finalPdf.buffer));

  console.log("\n🧪 Tenancy: every new route is 404 to another company");
  for (const [label, method, url, body] of [
    ["PATCH values", "PATCH", `/certificates/${dupId}/values`, { expectedVersion: 2, changes: { ph_result: "x" } }],
    ["reset", "POST", `/certificates/${dupId}/fields/ph_result/reset`, {}],
    ["versions", "GET", `/certificates/${dupId}/versions`],
    ["restore", "POST", `/certificates/${dupId}/versions/1/restore`, {}],
    ["export-pdf", "POST", `/certificates/${dupId}/export-pdf`],
    ["pdf", "GET", `/certificates/${add.certId}/pdf`],
    ["finalize", "POST", `/certificates/${dupId}/finalize`, {}],
    ["duplicate", "POST", `/certificates/${add.certId}/duplicate`],
    ["batch export", "POST", `/certificate-batches/${add.batchId}/export`],
    ["batch zip", "GET", `/certificate-batches/${add.batchId}/zip`],
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
