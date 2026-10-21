import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES } from "../services/certificates/jobs/queues.js";
import { runExtractJob, rematch } from "../services/certificates/invoices/invoiceService.js";

// Certificates V2 invoice worker (plan §5.2): `extract` (AI read + automatic
// matching) and `match`. Concurrency 1 — the free-tier Gemini RPM is shared
// across the whole app. Thin by design — the work is in services/certificates/invoices.
const handlers = {
  extract: ({ invoiceId }, ctx) => runExtractJob(invoiceId, ctx),
  match: ({ invoiceId, companyId }) => rematch(invoiceId, companyId),
};

export const invoiceWorker = startWorker({
  queueName: QUEUES.invoice,
  label: "Invoice Worker",
  concurrency: Number(process.env.INVOICE_CONCURRENCY) || 1,
  handlers,
});
