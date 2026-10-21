import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES, scheduleRepeating } from "../services/certificates/jobs/queues.js";
import { runGenerateBatch } from "../services/certificates/generation/batchService.js";
import { runExportPdf, runExportZip } from "../services/certificates/certificates/editService.js";
import { runDailyMaintenance } from "../services/certificates/maintenance/maintenanceService.js";

// Certificates V2 render worker (plan §5.2): `generateBatch`, `exportPdf`,
// `exportZip` (edits re-render inline in the API, plan §20 I21). One job at a
// time per process — each job renders 2 pages in parallel itself. Thin by
// design — the work is in services/certificates/generation/*.
const handlers = {
  generateBatch: ({ batchId }, ctx) => runGenerateBatch(batchId, ctx),
  exportPdf: (data) => runExportPdf(data),
  exportZip: (data, ctx) => runExportZip(data, ctx),
  cleanup: () => runDailyMaintenance(), // daily, plan §15
};

export const certificateRenderWorker = startWorker({
  queueName: QUEUES.render,
  label: "Certificate Render Worker",
  concurrency: Number(process.env.CERT_RENDER_CONCURRENCY) || 1,
  handlers,
});

// orphan files + stuck tasks, every day at 03:00 (server time)
scheduleRepeating(QUEUES.render, "certificates-daily-maintenance", process.env.CERT_MAINTENANCE_CRON || "0 3 * * *", "cleanup").catch((err) =>
  console.error(`[Certificate Render Worker] could not schedule the daily maintenance: ${err.message}`)
);
