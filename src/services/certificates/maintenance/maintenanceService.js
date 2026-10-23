import fs from "fs";
import { prisma } from "../../../lib/prisma.js";
import * as fileStore from "../storage/fileStore.js";
import { liveJobRefs } from "../jobs/queues.js";

// Operations (CERTIFICATES_V2_PLAN.md §15): the daily cleanup and the metrics.
//  - orphan StoredFiles: no row references them and they are older than 24 h
//    (a file is written before the row that points at it, so young files are
//    never touched). Old certificate versions are never orphans — they are the
//    audit trail.
//  - stuck tasks: a Certificates V2 BackgroundTask pending/processing for more
//    than 30 min, whose BullMQ job is no longer active/waiting/delayed, → failed with a reason, and its entity is put back into a state
//    the user can act on (never left "converting"/"generating" forever).

export const CERT_TASK_TYPES = [
  "certificate_template_convert",
  "certificate_template_prepare",
  "invoice_extract",
  "certificate_generate_batch",
  "certificate_export_pdf",
  "certificate_export_zip",
  "catalogue_segment", // product catalogues (plan.md §15, A6)
  "catalogue_extract",
];

/** Ids of every StoredFile some row still references. */
async function referencedFileIds() {
  const rows = await prisma.$queryRaw`
    SELECT source_file_id AS id FROM template_versions
    UNION SELECT sanitized_file_id FROM template_versions
    UNION SELECT prepared_file_id FROM template_versions
    UNION SELECT thumbnail_file_id FROM template_versions
    UNION SELECT d->>'fileId' FROM template_versions, jsonb_array_elements(COALESCE(prepare_report->'diffImages', '[]'::jsonb)) d
    UNION SELECT source_file_id FROM invoices
    UNION SELECT html_file_id FROM certificate_versions
    UNION SELECT pdf_file_id FROM certificate_versions
    UNION SELECT thumbnail_file_id FROM certificate_versions
    UNION SELECT final_pdf_file_id FROM certificates
    UNION SELECT zip_file_id FROM certificate_batches
    UNION SELECT source_file_id FROM catalogue_versions`; // a catalogue is kept forever (plan.md §15.7)
  return new Set(rows.map((r) => r.id).filter(Boolean));
}

/** Deletes unreferenced files older than `olderThanHours`. → { scanned, deleted, bytes } */
// `companyId` narrows a run to one tenant (tests); the daily job runs unscoped.
export async function cleanupOrphanFiles({ olderThanHours = 24, now = new Date(), companyId } = {}) {
  const cutoff = new Date(now.getTime() - olderThanHours * 3600_000);
  const candidates = await prisma.storedFile.findMany({ where: { createdAt: { lt: cutoff }, ...(companyId ? { companyId } : {}) }, select: { id: true, path: true, sizeBytes: true } });
  const referenced = await referencedFileIds();
  const orphans = candidates.filter((f) => !referenced.has(f.id));
  let bytes = 0;
  for (const f of orphans) {
    try {
      fs.unlinkSync(fileStore.absolutePath(f));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // already gone on disk: still drop the row
    }
    await prisma.storedFile.delete({ where: { id: f.id } });
    bytes += f.sizeBytes;
  }
  return { scanned: candidates.length, deleted: orphans.length, bytes };
}

/**
 * Files on disk under uploads/certificates with NO StoredFile row (a crash
 * between write and insert, a deleted row whose unlink failed), older than
 * `olderThanHours` → deleted (review #14). Young files are kept: putFile writes
 * the file before its row. → { scanned, deleted, bytes }
 */
export async function cleanupOrphanDiskFiles({ olderThanHours = 24, now = new Date(), companyId } = {}) {
  const cutoff = new Date(now.getTime() - olderThanHours * 3600_000);
  const old = fileStore.listDiskFiles(companyId ? [companyId] : null).filter((f) => f.mtime < cutoff);
  const known = new Set();
  for (let i = 0; i < old.length; i += 500) {
    const rows = await prisma.storedFile.findMany({ where: { path: { in: old.slice(i, i + 500).map((f) => f.relPath) } }, select: { path: true } });
    for (const r of rows) known.add(r.path);
  }
  let deleted = 0;
  let bytes = 0;
  for (const f of old) {
    if (known.has(f.relPath)) continue;
    try {
      fs.unlinkSync(f.abs);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    deleted++;
    bytes += f.size;
  }
  return { scanned: old.length, deleted, bytes };
}

/** Fails Certificates V2 tasks with no progress for `olderThanMinutes` and releases their entities. */
// `queueNames` is for tests (a private queue); the daily job checks the three real ones.
export async function failStuckTasks({ olderThanMinutes = 30, now = new Date(), companyId, queueNames } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const own = companyId ? { companyId } : {};
  const reason = `STUCK: no progress for ${olderThanMinutes} min — the worker probably stopped. Try again.`;
  // A long or queued job is not stuck: anything BullMQ still holds as
  // active/waiting/delayed is skipped, whatever its timestamps say (review #5).
  const live = await liveJobRefs(queueNames);
  const idsNotLive = (rows, set) => rows.map((r) => r.id).filter((id) => !set.has(id));
  const stuckTaskIds = idsNotLive(
    await prisma.backgroundTask.findMany({ where: { ...own, type: { in: CERT_TASK_TYPES }, status: { in: ["pending", "processing"] }, updatedAt: { lt: cutoff } }, select: { id: true } }),
    live.jobIds
  );
  const tasks = await prisma.backgroundTask.updateMany({ where: { id: { in: stuckTaskIds } }, data: { status: "failed", error: reason } });
  const versionScope = companyId ? { template: { companyId } } : {};
  const stuckVersions = async (status) =>
    idsNotLive(await prisma.templateVersion.findMany({ where: { ...versionScope, status, updatedAt: { lt: cutoff } }, select: { id: true } }), live.entityIds);
  const converting = await prisma.templateVersion.updateMany({ where: { id: { in: await stuckVersions({ in: ["uploaded", "converting"] }) } }, data: { status: "failed", error: reason } });
  const preparing = await prisma.templateVersion.updateMany({ where: { id: { in: await stuckVersions("preparing") } }, data: { status: "draft", error: reason } });
  const stuckInvoiceIds = idsNotLive(await prisma.invoice.findMany({ where: { ...own, status: { in: ["uploaded", "extracting"] }, updatedAt: { lt: cutoff } }, select: { id: true } }), live.entityIds);
  const extracting = await prisma.invoice.updateMany({ where: { id: { in: stuckInvoiceIds } }, data: { status: "failed", error: reason } });
  // a batch that never finished: its unrendered certificates fail, the invoice can be generated again
  const batches = (await prisma.certificateBatch.findMany({ where: { ...own, status: { in: ["queued", "running"] }, updatedAt: { lt: cutoff } }, select: { id: true, invoiceId: true } })).filter(
    (b) => !live.entityIds.has(b.id)
  );
  for (const b of batches) {
    await prisma.certificate.updateMany({ where: { batchId: b.id, status: "pending" }, data: { status: "failed", error: reason } });
    const certs = await prisma.certificate.findMany({ where: { batchId: b.id }, select: { status: true, flagCount: true } });
    const rendered = certs.filter((c) => c.status === "draft" || c.status === "final").length;
    const failed = certs.filter((c) => c.status === "failed").length;
    await prisma.certificateBatch.update({
      where: { id: b.id },
      data: { status: rendered ? "partially_failed" : "failed", finishedAt: now, counts: { planned: certs.length, rendered, failed, flagged: certs.filter((c) => c.status !== "failed" && c.flagCount > 0).length } },
    });
    await prisma.invoice.updateMany({ where: { id: b.invoiceId, status: "generating" }, data: { status: "partially_failed" } });
  }
  // a catalogue version whose segmentation never finished: failed, so the admin can upload it again
  const stuckCatalogueIds = idsNotLive(await prisma.catalogueVersion.findMany({ where: { ...own, status: { in: ["uploaded", "segmenting"] }, updatedAt: { lt: cutoff } }, select: { id: true } }), live.entityIds);
  const catalogues = await prisma.catalogueVersion.updateMany({ where: { id: { in: stuckCatalogueIds } }, data: { status: "failed", error: reason } });
  // …and one whose extraction never finished goes back to its blocks (segmented), to extract again
  const stuckExtractIds = idsNotLive(await prisma.catalogueVersion.findMany({ where: { ...own, status: "extracting", updatedAt: { lt: cutoff } }, select: { id: true } }), live.entityIds);
  const catalogueExtracting = await prisma.catalogueVersion.updateMany({ where: { id: { in: stuckExtractIds } }, data: { status: "segmented", error: reason } });
  return { tasks: tasks.count, templateVersions: converting.count + preparing.count, invoices: extracting.count, batches: batches.length, catalogueVersions: catalogues.count + catalogueExtracting.count };
}

/** The daily job. */
export async function runDailyMaintenance(opts = {}) {
  const stuck = await failStuckTasks(opts);
  const files = await cleanupOrphanFiles(opts);
  const diskFiles = await cleanupOrphanDiskFiles(opts);
  return { stuck, files, diskFiles, at: new Date().toISOString() };
}

// ── metrics (§15) ────────────────────────────────────────────────────────────
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const stats = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { count: v.length, avg: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null, p95: pct(v, 95) };
};
/** The most specific code in a stored error ("EXTRACTION_FAILED: … GEMINI_DISABLED: …" → GEMINI_DISABLED). */
const reasonOf = (error) => (String(error || "").match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || ["UNKNOWN"]).pop();

/** GET /certificate-metrics?days= → conversion ms, prepare pass rate, render ms, flags per batch, extraction failures by reason. */
export async function getMetrics(companyId, { days = 30 } = {}) {
  const since = new Date(Date.now() - Number(days) * 86_400_000);
  const [versions, batches, invoices] = await Promise.all([
    prisma.templateVersion.findMany({ where: { template: { companyId }, createdAt: { gte: since } }, select: { conversion: true, prepareReport: true } }),
    prisma.certificateBatch.findMany({ where: { companyId, createdAt: { gte: since }, finishedAt: { not: null } }, select: { counts: true, status: true } }),
    prisma.invoice.findMany({ where: { companyId, createdAt: { gte: since } }, select: { status: true, error: true, extraction: true } }),
  ]);
  const prepared = versions.filter((v) => v.prepareReport && "passed" in v.prepareReport);
  const failures = invoices.filter((i) => i.status === "failed");
  const byReason = {};
  for (const f of failures) byReason[reasonOf(f.error)] = (byReason[reasonOf(f.error)] || 0) + 1;
  const planned = batches.reduce((n, b) => n + (b.counts?.planned || 0), 0);
  const flagged = batches.reduce((n, b) => n + (b.counts?.flagged || 0), 0);
  return {
    since: since.toISOString(),
    conversion: stats(versions.map((v) => v.conversion?.ms)),
    prepare: { runs: prepared.length, passed: prepared.filter((v) => v.prepareReport.passed).length, passRate: prepared.length ? +(prepared.filter((v) => v.prepareReport.passed).length / prepared.length).toFixed(3) : null },
    generation: {
      batches: batches.length,
      byStatus: batches.reduce((m, b) => ({ ...m, [b.status]: (m[b.status] || 0) + 1 }), {}),
      certificates: { planned, rendered: batches.reduce((n, b) => n + (b.counts?.rendered || 0), 0), failed: batches.reduce((n, b) => n + (b.counts?.failed || 0), 0), flagged },
      renderMsPerCertificate: stats(batches.map((b) => b.counts?.renderMsAvg)),
      batchMs: stats(batches.map((b) => b.counts?.ms)),
      flagsPerBatch: batches.length ? +(flagged / batches.length).toFixed(2) : null,
      flaggedShare: planned ? +(flagged / planned).toFixed(3) : null,
    },
    extraction: { invoices: invoices.length, failed: failures.length, failuresByReason: byReason, ms: stats(invoices.map((i) => i.extraction?.ms)) },
  };
}
