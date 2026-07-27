import fs from "fs";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { verifyProductLabel } from "../services/labelService.js";
import io from "socket.io-client";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[Label Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

const worker = new Worker(
  "labelQueue",
  async (job) => {
    const { filePath, fileName, mimeType, country, companyId } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[Label Worker] Starting job ${job.id} (Task ${taskId})`);

    // 1. Update DB task status to processing
    await prisma.backgroundTask.update({
      where: { id: taskId },
      data: { status: "processing" },
    });

    // Notify status via ws
    socket.emit("job_status_update", {
      jobId: taskId,
      companyId,
      type: "label_verification",
      status: "processing",
    });

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Uploaded label file not found at ${filePath}`);
      }

      // 2. Read file as buffer
      const fileBuffer = fs.readFileSync(filePath);

      // 3. Process label verification with progress reporting
      const result = await verifyProductLabel(fileBuffer, fileName, mimeType, country, companyId, (progress, message) => {
        socket.emit("job_status_update", {
          jobId: taskId,
          companyId,
          type: "label_verification",
          status: "processing",
          progress,
          message
        });
      });

      // 4. Update DB task status to completed
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          result: result,
        },
      });

      // 5. Broadcast success
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        type: "label_verification",
        status: "completed",
        result,
      });

      console.log(`[Label Worker] Successfully completed task ${taskId}`);
    } catch (error) {
      console.error(`[Label Worker] Failed processing task ${taskId}:`, error);

      // Update DB task status to failed
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "failed",
          error: error.message,
        },
      });

      // Broadcast failure
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        type: "label_verification",
        status: "failed",
        error: error.message,
      });
    } finally {
      // 6. Delete the temp file from the shared volume
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Label Worker] Cleaned up file ${filePath}`);
        } catch (err) {
          console.error(`[Label Worker] Failed to delete file ${filePath}:`, err.message);
        }
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[Label Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[Label Worker] Job ${job?.id} failed:`, err));
