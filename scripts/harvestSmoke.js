// After a deploy (scripts/deploy.sh): the harvest worker must take a job on its queue and read a small PDF
// end to end within 2 minutes. Exit 0 = it did; anything else = the deploy is broken (it says why).
//   node scripts/harvestSmoke.js
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { enqueueTask, QUEUES } from "../src/services/certificates/jobs/queues.js";

const LIMIT_MS = Number(process.env.HARVEST_SMOKE_LIMIT_S || 120) * 1000;
const t0 = Date.now();
const task = await enqueueTask({ queueName: QUEUES.harvest, jobName: "harvestSmoke", type: "harvest_smoke", companyId: null, data: { entity: "deploy", entityId: "harvest-smoke" } });
let row;
let picked = false;
while (Date.now() - t0 < LIMIT_MS) {
  row = await prisma.backgroundTask.findUnique({ where: { id: task.id }, select: { status: true, result: true, error: true } });
  if (row.status !== "pending") picked = true;
  if (["completed", "failed"].includes(row.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const s = Math.round((Date.now() - t0) / 1000);
if (row?.status === "completed") {
  console.log(`harvest smoke OK in ${s} s: ${row.result?.values} value(s) read by ${row.result?.model} (${(row.result?.fields || []).join(", ")})`);
  process.exit(0);
}
const why = row?.status === "failed" ? `the read failed: ${row.error}` : picked ? `the worker took the job but didn't finish in ${s} s` : `no worker took the job in ${s} s (queue ${QUEUES.harvest}: is harvest-worker running and on the same Redis?)`;
console.error(`harvest smoke FAILED — ${why}`);
process.exit(1);
