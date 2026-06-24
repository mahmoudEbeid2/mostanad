import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { sendWelcomeEmail } from "../lib/email.js";

const connection = getRedisConfig();

const worker = new Worker(
  "emailQueue",
  async (job) => {
    const { type, to, data } = job.data;

    console.log(`[Email Worker] Starting job ${job.id} of type "${type}" to ${to}`);

    try {
      if (type === "welcome") {
        const { name, username, password } = data;
        await sendWelcomeEmail(to, name, username, password);
      } else {
        console.warn(`[Email Worker] Unknown email job type: ${type}`);
      }
      console.log(`[Email Worker] Successfully completed job ${job.id}`);
    } catch (error) {
      console.error(`[Email Worker] Failed processing job ${job.id}:`, error);
      throw error; // Let BullMQ mark the job as failed and potentially retry
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[Email Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[Email Worker] Job ${job?.id} failed:`, err));
