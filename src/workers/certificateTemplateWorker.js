import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES } from "../services/certificates/jobs/queues.js";
import { convertVersion } from "../services/certificates/templates/templateService.js";
import { runPrepareJob } from "../services/certificates/templates/prepareService.js";

// Certificates V2 template worker (plan §5.2): `convert` (upload → sanitize →
// analyse) and `prepare` (clear fields + gate). Thin by design — the work is
// in services/certificates/templates/*.
const handlers = {
  convert: ({ versionId }, ctx) => convertVersion(versionId, ctx),
  prepare: ({ versionId }, ctx) => runPrepareJob(versionId, ctx),
};

export const certificateTemplateWorker = startWorker({
  queueName: QUEUES.template,
  label: "Certificate Template Worker",
  concurrency: 2,
  handlers,
});
