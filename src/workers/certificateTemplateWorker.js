import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES, scheduleRepeating } from "../services/certificates/jobs/queues.js";
import { convertVersion } from "../services/certificates/templates/templateService.js";
import { runPrepareJob } from "../services/certificates/templates/prepareService.js";
import { runRepairJob } from "../services/certificates/templates/repairService.js";
import { buildDictionary } from "../services/certificates/dictionary/dataDictionary.js";
import { rebuildAllDictionaries } from "../services/certificates/dictionary/rebuildScheduler.js";

// Certificates V2 template worker (plan §5.2): `convert` (upload → sanitize →
// analyse) and `prepare` (clear fields + gate). Thin by design — the work is
// in services/certificates/templates/*.
const handlers = {
  convert: ({ versionId }, ctx) => convertVersion(versionId, ctx),
  prepare: ({ versionId }, ctx) => runPrepareJob(versionId, ctx),
  // "Fix this template" (item 2): convert (vector background) → apply the ticked changes → prepare
  repair: (data, ctx) => runRepairJob(data, ctx),
  // company data dictionary (plan.md §3.2): after product changes, and nightly
  rebuildDictionary: async ({ companyId }) => {
    const row = await buildDictionary(companyId);
    return { version: row.version, entries: row.entries.length };
  },
  rebuildDictionaries: () => rebuildAllDictionaries(),
};

export const certificateTemplateWorker = startWorker({
  queueName: QUEUES.template,
  label: "Certificate Template Worker",
  concurrency: Number(process.env.CERT_TEMPLATE_CONCURRENCY) || 2,
  handlers,
});

// every company's data dictionary, every night at 02:30 (server time)
scheduleRepeating(QUEUES.template, "certificates-dictionary-nightly", process.env.CERT_DICTIONARY_CRON || "30 2 * * *", "rebuildDictionaries").catch((err) =>
  console.error(`[Certificate Template Worker] could not schedule the nightly dictionary rebuild: ${err.message}`)
);
