import { withAiJobContext } from "../../ai/aiContext.js";
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

const PROGRESS_SAVE_MS = 500;

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
    // AI cost ledger: calls outside runLogged are still billed to the job's company
    (job) => withAiJobContext(job, async () => {
      const handler = handlers[job.name];
      if (!handler) throw new Error(`[${label}] no handler for job "${job.name}"`);
      const { taskId = null, companyId = null } = job.data;
      const startedAt = Date.now();
      const base = { jobId: taskId, companyId, type: job.name };

      if (taskId) {
        await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
        emit({ ...base, status: "processing" });
      }
      // the row is the truth: progress is saved on it too (at most twice a second, always on a new
      // stage, in order), so GET /background-tasks/:id carries it without the socket
      let saves = Promise.resolve();
      let savedAt = 0;
      let savedStage = null;
      const save = (data) => {
        saves = saves.then(() => prisma.backgroundTask.update({ where: { id: taskId }, data })).catch((err) => console.error(`[${label}] could not save progress of ${taskId}: ${err.message}`));
      };
      const ctx = {
        progress: (progress, message, extra = {}) => {
          if (process.env.CERT_JOB_TRACE === "true") console.log(`[${label}] ${job.name} ${job.data.entityId || ""} ${progress}% ${message}`);
          if (!taskId) return;
          emit({ ...base, status: "processing", progress, message, ...extra });
          const stage = extra.stage ?? savedStage;
          if (stage === savedStage && Date.now() - savedAt < PROGRESS_SAVE_MS) return;
          savedAt = Date.now();
          savedStage = stage;
          save({ progress: Math.round(progress), message: message ?? null, stage, ...(extra.stages ? { stages: extra.stages } : {}) });
        },
      };

      try {
        const result = await handler(job.data, ctx);
        const ms = Date.now() - startedAt;
        if (taskId) {
          await saves;
          await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", progress: 100, result: result ?? {} } });
          emit({ ...base, status: "completed", result });
        }
        console.log(`[${label}] ${JSON.stringify({ job: job.name, entity: job.data.entity, id: job.data.entityId, companyId, ms, outcome: "completed" })}`);
        return result;
      } catch (err) {
        const ms = Date.now() - startedAt;
        const message = err.code ? `${err.code}: ${err.message}` : err.message;
        if (taskId) {
          await saves;
          await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "failed", error: message } });
          emit({ ...base, status: "failed", error: message });
        }
        console.error(`[${label}] ${JSON.stringify({ job: job.name, entity: job.data.entity, id: job.data.entityId, companyId, ms, outcome: "failed", error: message })}`);
        throw err;
      }
    }),
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
