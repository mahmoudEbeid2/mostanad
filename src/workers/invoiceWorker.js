import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES } from "../services/certificates/jobs/queues.js";
import { runExtractJob, rematch } from "../services/certificates/invoices/invoiceService.js";
import { runCoaJob } from "../services/certificates/labResults/coaService.js";
import { runPrepareJob } from "../services/certificates/prepare/prepareService.js";

// Certificates V2 invoice worker (plan §5.2): `extract` (AI read + automatic
// matching), `match`, `coa` (supplier COA / lab report reading, item 4) and `prepare` (item 5). Concurrency 1 — the free-tier Gemini RPM is shared
// across the whole app. Thin by design — the work is in services/certificates/invoices.
const handlers = {
  extract: ({ invoiceId }, ctx) => runExtractJob(invoiceId, ctx),
  match: ({ invoiceId, companyId }) => rematch(invoiceId, companyId),
  coa: ({ invoiceId, coaIds }, ctx) => runCoaJob({ invoiceId, coaIds }, ctx), // item 4: supplier COAs
  prepare: ({ invoiceId }, ctx) => runPrepareJob({ invoiceId }, ctx), // item 5: "Prepare certificates"
};

export const invoiceWorker = startWorker({
  queueName: QUEUES.invoice,
  label: "Invoice Worker",
  concurrency: Number(process.env.INVOICE_CONCURRENCY) || 1,
  handlers,
});
