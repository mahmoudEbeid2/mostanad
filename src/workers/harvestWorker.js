import { startWorker } from "../services/certificates/jobs/taskRunner.js";
import { QUEUES } from "../services/certificates/jobs/queues.js";
import { runDropHarvest, harvestModelOrNull } from "../services/harvest/harvestAi.js";
import { reharvestCompany } from "../services/harvest/harvestService.js";
import { runHarvestSmoke } from "../services/harvest/harvestSmoke.js";

// The harvest worker (28 Nov): reading every file of a drop with Gemini (upload → File API URI →
// generateContent → store) runs here, in its own container (harvest-worker), on its own queue — never
// behind template conversions, preparations or Express in the template worker. Thin by design: the work
// is in services/harvest/*.
const handlers = {
  harvestDrop: ({ batchId }, ctx) => runDropHarvest(batchId, ctx),
  reharvestCompany: ({ companyId }, ctx) => reharvestCompany(companyId, ctx),
  // the deploy's check: a tiny PDF read end to end (scripts/deploy.sh)
  harvestSmoke: (data, ctx) => runHarvestSmoke(data, ctx),
};

export const harvestWorker = startWorker({
  queueName: QUEUES.harvest,
  label: "Harvest Worker",
  concurrency: Number(process.env.HARVEST_CONCURRENCY) || 2,
  handlers,
});

harvestWorker.on("ready", () => console.log(`harvest worker ready, queue=${QUEUES.harvest}, model=${harvestModelOrNull() || "off (GEMINI_HARVEST_MODEL not set)"}`));
