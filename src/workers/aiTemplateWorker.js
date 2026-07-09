import fs from "fs";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { generateHtmlFromDesign } from "../services/aiTemplateService.js";
import io from "socket.io-client";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[AI Template Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[AI Template Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

const worker = new Worker(
  "aiTemplateQueue",
  async (job) => {
    const { companyId, brandId, templateName, filePath, fileName, mimeType } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[AI Template Worker] Starting job ${job.id} (Task ${taskId})`);

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
      type: "ai_template_generation",
      status: "processing",
    });

    let serviceFileName = fileName;
    let serviceMimeType = mimeType;

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Uploaded design file not found at ${filePath}`);
      }

      // 2. Process HTML generation
      let generatedHtml = await generateHtmlFromDesign(
        filePath,
        serviceFileName,
        serviceMimeType
      );

      // Extract dynamic fields to populate requiredFields
      const extractedFields = {};
      const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
      let match;
      while ((match = regex.exec(generatedHtml)) !== null) {
        extractedFields[match[1]] = "string";
      }

      // 3. Create the template in database
      const newTemplate = await prisma.template.create({
        data: {
          name: templateName || "AI Generated Template",
          type: "certificate", // default
          companyId,
          brandId: brandId || null,
          isGlobal: false,
          fields: extractedFields,
          htmlContent: generatedHtml,
          isActive: true
        }
      });

      // 4. Update DB task status to completed
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          result: { templateId: newTemplate.id, html: generatedHtml },
        },
      });

      // 5. Broadcast success
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        brandId,
        type: "ai_template_generation",
        status: "completed",
        result: { templateId: newTemplate.id },
      });

      console.log(`[AI Template Worker] Successfully completed task ${taskId}`);
    } catch (error) {
      console.error(`[AI Template Worker] Failed processing task ${taskId}:`, error);

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
        type: "ai_template_generation",
        status: "failed",
        error: error.message,
      });
    } finally {
      // 6. Delete the temp file from the shared volume
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[AI Template Worker] Cleaned up file ${filePath}`);
        } catch (err) {
          console.error(`[AI Template Worker] Failed to delete file ${filePath}:`, err.message);
        }
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[AI Template Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[AI Template Worker] Job ${job?.id} failed:`, err));
