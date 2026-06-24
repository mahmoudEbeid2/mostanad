import fs from "fs";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { processCatalogPDF } from "../services/catalogService.js";
import io from "socket.io-client";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Catalog Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[Catalog Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

const worker = new Worker(
  "catalogQueue",
  async (job) => {
    const { companyId, filePath, fileName, brandId } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[Catalog Worker] Starting job ${job.id} (Task ${taskId})`);

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
      type: "catalog_upload",
      status: "processing",
    });

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Uploaded catalog file not found at ${filePath}`);
      }

      // 2. Read file as buffer
      const fileBuffer = fs.readFileSync(filePath);

      // 3. Process Catalog
      const result = await processCatalogPDF(companyId, fileBuffer, fileName, brandId);

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
        type: "catalog_upload",
        status: "completed",
        result,
      });

      console.log(`[Catalog Worker] Successfully completed task ${taskId}`);
    } catch (error) {
      console.error(`[Catalog Worker] Failed processing task ${taskId}:`, error);

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
        type: "catalog_upload",
        status: "failed",
        error: error.message,
      });
    } finally {
      // 6. Delete the temp file from the shared volume
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Catalog Worker] Cleaned up file ${filePath}`);
        } catch (err) {
          console.error(`[Catalog Worker] Failed to delete file ${filePath}:`, err.message);
        }
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[Catalog Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[Catalog Worker] Job ${job?.id} failed:`, err));
