// Docker healthcheck for a worker container (28 Nov): healthy only when a worker is connected to its queue
// (BullMQ's client list) — a process that is up but not consuming fails it, and the container is restarted.
//   node src/workers/workerHealthcheck.js harvest
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { QUEUES } from "../services/certificates/jobs/queues.js";

const name = QUEUES[process.argv[2]];
if (!name) {
  console.error(`unknown queue "${process.argv[2]}" (one of ${Object.keys(QUEUES).join(", ")})`);
  process.exit(1);
}
const q = new Queue(name, { connection: getRedisConfig() });
const timer = setTimeout(() => {
  console.error(`${name}: no answer from Redis in 8 s`);
  process.exit(1);
}, 8000);
try {
  const workers = await q.getWorkers();
  clearTimeout(timer);
  console.log(`${name}: ${workers.length} worker(s) connected`);
  await q.close();
  process.exit(workers.length > 0 ? 0 : 1);
} catch (err) {
  console.error(`${name}: ${err.message}`);
  process.exit(1);
}
