import fs from "fs";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { generateCertificatesAndPopulateTemplates } from "../services/certificateService.js";
import io from "socket.io-client";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Certificate Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[Certificate Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

const worker = new Worker(
  "certificateQueue",
  async (job) => {
    const { companyId, brandId, transactionType, filePath, fileName, mimeType } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[Certificate Worker] Starting job ${job.id} (Task ${taskId})`);

    // 1. Update DB task status to processing
    await prisma.backgroundTask.update({
      where: { id: taskId },
      data: { status: "processing" },
    });

    // Notify status via ws
    socket.emit("job_status_update", {
      jobId: taskId,
      companyId,
      brandId,
      type: "certificate_generation",
      status: "processing",
    });

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Uploaded invoice file not found at ${filePath}`);
      }

      // 2. Read file as buffer
      const fileBuffer = fs.readFileSync(filePath);

      // 3. Process certificate generation
      const result = await generateCertificatesAndPopulateTemplates(
        companyId,
        brandId || null,
        transactionType,
        fileBuffer,
        fileName,
        mimeType
      );

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
        brandId,
        type: "certificate_generation",
        status: "completed",
        result,
      });

      console.log(`[Certificate Worker] Successfully completed task ${taskId}`);
    } catch (error) {
      console.error(`[Certificate Worker] Failed processing task ${taskId}:`, error);

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
        brandId,
        type: "certificate_generation",
        status: "failed",
        error: error.message,
      });
    } finally {
      // 6. Delete the temp file from the shared volume
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Certificate Worker] Cleaned up file ${filePath}`);
        } catch (err) {
          console.error(`[Certificate Worker] Failed to delete file ${filePath}:`, err.message);
        }
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[Certificate Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[Certificate Worker] Job ${job?.id} failed:`, err));
