import { Worker } from "bullmq";
import io from "socket.io-client";
import { getRedisConfig } from "../../../lib/redis.js";
import { prisma } from "../../../lib/prisma.js";
import { geminiWorkerName } from "../../ai/geminiGuard.js";

// One runner for the three Certificates V2 workers, so each worker file stays
// thin (CLAUDE.md layering): it maps job names to service functions, and this
// file does the BackgroundTask bookkeeping, socket `job_status_update`
// progress and the structured job log { entity, id, companyId, ms, outcome }
// (plan §15). Business logic never lives here.

/**
 * startWorker({ queueName, label, concurrency, handlers: { [jobName]: async (data, ctx) => result } })
 * ctx.progress(progress, message, extra) emits a processing update.
 */
export function startWorker({ queueName, label, concurrency = 1, handlers }) {
  const wsUrl = process.env.BACKEND_WS_URL || "http://localhost:3000";
  const socket = io(wsUrl);
  socket.on("connect_error", (err) => console.error(`[${label}] Socket connection error: ${err.message}`));

  const emit = (payload) => socket.emit("job_status_update", payload);

  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = handlers[job.name];
      if (!handler) throw new Error(`[${label}] no handler for job "${job.name}"`);
      const { taskId = null, companyId = null } = job.data;
      const startedAt = Date.now();
      const base = { jobId: taskId, companyId, type: job.name };

      if (taskId) {
        await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
        emit({ ...base, status: "processing" });
      }
      const ctx = {
        progress: (progress, message, extra = {}) => {
          if (process.env.CERT_JOB_TRACE === "true") console.log(`[${label}] ${job.name} ${job.data.entityId || ""} ${progress}% ${message}`);
          if (taskId) emit({ ...base, status: "processing", progress, message, ...extra });
        },
      };

      try {
        const result = await handler(job.data, ctx);
        const ms = Date.now() - startedAt;
        if (taskId) {
          await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", result: result ?? {} } });
          emit({ ...base, status: "completed", result });
        }
        console.log(`[${label}] ${JSON.stringify({ job: job.name, entity: job.data.entity, id: job.data.entityId, companyId, ms, outcome: "completed" })}`);
        return result;
      } catch (err) {
        const ms = Date.now() - startedAt;
        const message = err.code ? `${err.code}: ${err.message}` : err.message;
        if (taskId) {
          await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "failed", error: message } });
          emit({ ...base, status: "failed", error: message });
        }
        console.error(`[${label}] ${JSON.stringify({ job: job.name, entity: job.data.entity, id: job.data.entityId, companyId, ms, outcome: "failed", error: message })}`);
        throw err;
      }
    },
    { connection: getRedisConfig(), concurrency, name: geminiWorkerName(queueName) }
  );

  worker.on("ready", () => console.log(`[${label}] listening on ${queueName} (concurrency ${concurrency})`));
  const shutdown = async () => {
    await worker.close();
    socket.close();
  };
  process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  return worker;
}
