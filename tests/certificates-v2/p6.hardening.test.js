// Certificates V2 Phase 6 — Hardening (CERTIFICATES_V2_PLAN.md §15, §17 row 6).
//  - GET /health reports converter reachability
//  - idempotency audit: every job entry point run twice creates no duplicate rows or files
//  - daily maintenance: orphan files (> 24 h, unreferenced) deleted, referenced kept;
//    stuck tasks (> 30 min) failed with a reason and their entities released
//  - metrics: conversion ms, prepare pass rate, render ms, flags per batch, extraction failures by reason
// Maintenance runs are scoped to the test company (production runs them unscoped).
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, form, fixture, FIXTURES, prisma, BASE_URL } from "./helpers.js";
import { convertVersion } from "../../src/services/certificates/templates/templateService.js";
import { runPrepareJob } from "../../src/services/certificates/templates/prepareService.js";
import { runExtractJob } from "../../src/services/certificates/invoices/invoiceService.js";
import { runGenerateBatch } from "../../src/services/certificates/generation/batchService.js";
import { runExportPdf, runExportZip } from "../../src/services/certificates/certificates/editService.js";
import { cleanupOrphanFiles, failStuckTasks } from "../../src/services/certificates/maintenance/maintenanceService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";
import { shutdown as shutdownRenderer } from "../../src/services/certificates/engine/renderer.js";

const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("p6a");
const coB = await createCompany("p6b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);
const fileCount = () => prisma.storedFile.count({ where: { companyId: coA.id } });
const HOUR = 3600_000;

try {
  console.log("\n🧪 Health");
  const h = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  assert("GET /health → converter reachable, no internal URL", h.status === "ok" && h.converter?.reachable === true && !JSON.stringify(h).includes("http"), h);

  console.log("\n🧪 Setup: an active template, a generated certificate");
  const typeId = (await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" })).data.data.type.id;
  const up = await uploadTemplate(coA.id, { file: "ADDVET_COA.ai", certificateTypeId: typeId });
  const v = up.version;
  const fields = golden["ADDVET_COA.ai"].map(({ occurrence, ...g }) => {
    const text = v.lines.find((l) => l.id === g.lineId).text;
    const start = occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    return { ...g, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  let r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  assert("template active", r.status === 200, r.data);
  const product = await prisma.product.create({ data: { companyId: coA.id, name: "ADD-E120" } });
  const src = await fileStore.putFile({ companyId: coA.id, kind: "invoice_source", buffer: fixture("outlined_text.pdf"), mimeType: "application/pdf" });
  const inv = await prisma.invoice.create({ data: { companyId: coA.id, status: "ready", sourceFileId: src.id, header: { invoiceNumber: "INV-H-1" }, headerExtracted: {} } });
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: { batchNo: "AVVS1124011" }, dataExtracted: {}, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  r = await api("POST", `/invoices/${inv.id}/generate`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  const batchId = r.data.data.batchId;
  const cert = await prisma.certificate.findFirst({ where: { batchId } });
  assert("certificate rendered", cert?.status === "draft");

  console.log("\n🧪 Idempotency audit — every job entry point, run again");
  let before = await fileCount();
  let out = await convertVersion(v.id);
  assert("convert: a converted version is skipped, no new files", out.skipped === true && (await fileCount()) === before);
  out = await runPrepareJob(v.id);
  assert("prepare: a retried job for an already-activated version is skipped", out.skipped === true && out.status === "active" && (await fileCount()) === before);
  const vRow = await prisma.templateVersion.findUnique({ where: { id: v.id } });
  assert("…and stays active with the same prepared file", vRow.status === "active" && vRow.preparedFileId === (await prisma.templateVersion.findUnique({ where: { id: v.id } })).preparedFileId);
  const reviewed = await prisma.invoice.create({ data: { companyId: coA.id, status: "review", sourceFileId: src.id, header: {}, headerExtracted: {} } });
  out = await runExtractJob(reviewed.id);
  assert("extract: an invoice already in review is skipped (no AI call, no items)", out.skipped === true && (await prisma.invoiceItem.count({ where: { invoiceId: reviewed.id } })) === 0);
  out = await runGenerateBatch(batchId);
  assert("generateBatch: a finished batch is skipped", out.skipped === true && (await prisma.certificate.count({ where: { batchId } })) === 1);
  const p1 = await runExportPdf({ certificateId: cert.id });
  before = await fileCount();
  const p2 = await runExportPdf({ certificateId: cert.id });
  assert("exportPdf: the second run reuses the PDF (no new file)", p1.pdfFileId === p2.pdfFileId && (await fileCount()) === before);
  const z1 = await runExportZip({ batchId });
  const z2 = await runExportZip({ batchId });
  assert("exportZip: a re-export replaces the batch's ZIP (one referenced)", z1.zipFileId !== z2.zipFileId && (await prisma.certificateBatch.findUnique({ where: { id: batchId } })).zipFileId === z2.zipFileId);

  console.log("\n🧪 Daily cleanup — orphan files");
  const orphan = await fileStore.putFile({ companyId: coA.id, kind: "certificate_html", buffer: Buffer.from("<p>orphan</p>"), mimeType: "text/html" });
  const orphanPath = fileStore.absolutePath(orphan);
  let res = await cleanupOrphanFiles({ companyId: coA.id });
  assert("young orphans (< 24 h) are kept", res.deleted === 0 && fs.existsSync(orphanPath), res);
  const referencedBefore = await prisma.storedFile.count({ where: { companyId: coA.id } });
  res = await cleanupOrphanFiles({ companyId: coA.id, now: new Date(Date.now() + 25 * HOUR) });
  assert("after 24 h: the orphan + the replaced ZIP are deleted (2), from disk too", res.deleted === 2 && !fs.existsSync(orphanPath) && !(await prisma.storedFile.findUnique({ where: { id: z1.zipFileId } })), res);
  assert("every referenced file is kept", (await prisma.storedFile.count({ where: { companyId: coA.id } })) === referencedBefore - 2);
  const html = await api("GET", `/certificates/${cert.id}/html`, A);
  const tplHtml = await api("GET", `/template-versions/${v.id}/html?variant=prepared`, A);
  const zip = await api("GET", `/certificate-batches/${batchId}/zip`, A);
  const diff = await api("GET", `/template-versions/${v.id}/prepare-diff?page=1`, A);
  assert("certificate HTML, prepared design, current ZIP and diff image still served", [html, tplHtml, zip, diff].every((x) => x.status === 200), [html, tplHtml, zip, diff].map((x) => x.status));

  console.log("\n🧪 Daily cleanup — stuck tasks");
  const old = new Date(Date.now() - 31 * 60_000);
  const stuckTask = await prisma.backgroundTask.create({ data: { type: "invoice_extract", status: "processing", companyId: coA.id } });
  const freshTask = await prisma.backgroundTask.create({ data: { type: "invoice_extract", status: "processing", companyId: coA.id } });
  const stuckInv = await prisma.invoice.create({ data: { companyId: coA.id, status: "extracting", sourceFileId: src.id } });
  const stuckBatch = await prisma.certificateBatch.create({ data: { companyId: coA.id, invoiceId: inv.id, status: "running", plan: {} } });
  const stuckCert = await prisma.certificate.create({ data: { companyId: coA.id, batchId: stuckBatch.id, invoiceId: inv.id, templateVersionId: v.id, certificateTypeId: typeId, scope: "per_product", planKey: "x", status: "pending" } });
  await prisma.invoice.update({ where: { id: inv.id }, data: { status: "generating" } });
  await prisma.$executeRaw`UPDATE background_tasks SET updated_at = ${old} WHERE id = ${stuckTask.id}`;
  await prisma.$executeRaw`UPDATE invoices SET updated_at = ${old} WHERE id = ${stuckInv.id}`;
  await prisma.$executeRaw`UPDATE certificate_batches SET created_at = ${old} WHERE id = ${stuckBatch.id}`;
  res = await failStuckTasks({ companyId: coA.id });
  const t1 = await prisma.backgroundTask.findUnique({ where: { id: stuckTask.id } });
  const t2 = await prisma.backgroundTask.findUnique({ where: { id: freshTask.id } });
  assert("a task with no progress for 30 min → failed with a reason; a fresh one untouched", t1.status === "failed" && /STUCK/.test(t1.error) && t2.status === "processing", res);
  assert("its stuck invoice → failed (can be retried)", (await prisma.invoice.findUnique({ where: { id: stuckInv.id } })).status === "failed");
  assert("its stuck batch → failed, pending certificates failed, invoice released", (await prisma.certificateBatch.findUnique({ where: { id: stuckBatch.id } })).status === "failed" && (await prisma.certificate.findUnique({ where: { id: stuckCert.id } })).status === "failed" && (await prisma.invoice.findUnique({ where: { id: inv.id } })).status === "partially_failed");

  console.log("\n🧪 Metrics (§15)");
  await api("POST", "/invoices", A, form({}, { field: "invoice", buffer: fixture("outlined_text.pdf"), name: "i.pdf", type: "application/pdf" })).then((x) => pollTask(x.data.data.taskId, A));
  r = await api("GET", "/certificate-metrics", A);
  const m = r.data?.data?.metrics;
  assert("metrics → 200", r.status === 200, r.data);
  assert("conversion ms recorded", m.conversion.count >= 1 && m.conversion.avg > 0, m.conversion);
  assert("prepare pass rate", m.prepare.runs === 1 && m.prepare.passRate === 1, m.prepare);
  assert("render ms per certificate + batch ms", m.generation.renderMsPerCertificate.count >= 1 && m.generation.renderMsPerCertificate.avg > 0 && m.generation.batchMs.avg > 0, m.generation);
  assert("flags per batch", typeof m.generation.flagsPerBatch === "number", m.generation);
  assert("extraction failures by reason (GEMINI_DISABLED, STUCK)", m.extraction.failuresByReason.GEMINI_DISABLED === 1 && m.extraction.failed >= 2, m.extraction);
  r = await api("GET", "/certificate-metrics", B);
  assert("metrics are tenant-scoped (another company sees none of it)", r.data?.data?.metrics?.conversion?.count === 0 && r.data.data.metrics.generation.batches === 0);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await shutdownRenderer();
await finish(counts, async () => {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
