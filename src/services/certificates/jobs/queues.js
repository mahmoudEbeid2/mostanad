import { Queue } from "bullmq";
import { getRedisConfig } from "../../../lib/redis.js";
import { prisma } from "../../../lib/prisma.js";

// The three Certificates V2 queues (CERTIFICATES_V2_PLAN.md §5.2). Every job
// carries the BackgroundTask id as its BullMQ jobId and is idempotent by
// entity id — a retried job never creates duplicate rows.
export const QUEUES = {
  template: "certificateTemplateQueue", // convert, prepare
  invoice: "invoiceQueue", // extract, match
  render: "certificateRenderQueue", // generateBatch, renderVersion, exportPdf, exportZip
};

const connection = getRedisConfig();
const queues = {};
const queueFor = (name) => (queues[name] ||= new Queue(name, { connection }));

/**
 * Creates the BackgroundTask row and enqueues `jobName` on `queueName`.
 * → the task row (its id is the jobId the client polls via /background-tasks/:id).
 */
export async function enqueueTask({ queueName, jobName, type, companyId, data, attempts = 1 }) {
  const task = await prisma.backgroundTask.create({ data: { type, status: "pending", companyId } });
  await queueFor(queueName).add(jobName, { ...data, companyId, taskId: task.id }, {
    jobId: task.id,
    attempts,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
  return task;
}

/** Enqueues without a BackgroundTask (internal follow-up jobs, e.g. auto-match after extract). */
export async function enqueueRaw(queueName, jobName, data, opts = {}) {
  return queueFor(queueName).add(jobName, data, { removeOnComplete: 1000, removeOnFail: 5000, ...opts });
}

/**
 * Registers (or updates) a repeating job — idempotent, so every worker start
 * can call it (BullMQ job schedulers, one per id).
 */
export async function scheduleRepeating(queueName, schedulerId, pattern, jobName, data = {}) {
  return queueFor(queueName).upsertJobScheduler(schedulerId, { pattern }, { name: jobName, data, opts: { removeOnComplete: 30, removeOnFail: 100 } });
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
