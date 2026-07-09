import fs from "fs";
import path from "path";
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
    const { companyId, brandId, templateName, fileBufferBase64, fileName, mimeType } = job.data;
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

    let tempFilePath = null;
    let serviceFileName = fileName;
    let serviceMimeType = mimeType;

    try {
      if (!fileBufferBase64) {
        throw new Error(`Uploaded design file buffer not found in job data`);
      }

      if (!serviceFileName.toLowerCase().endsWith('.svg')) {
        throw new Error("Hybrid SVG Injection mode ONLY supports .svg files. Please export your design as SVG in Illustrator and upload it.");
      }

      const tempFileName = `ai_design_${Date.now()}_${Math.random().toString(36).substring(7)}_${fileName}`;
      tempFilePath = path.join(process.cwd(), tempFileName);
      fs.writeFileSync(tempFilePath, Buffer.from(fileBufferBase64, 'base64'));

      // 2. Extract dynamic fields using AI
      let jsonArrayString = await generateHtmlFromDesign(
        tempFilePath,
        serviceFileName,
        serviceMimeType
      );

      let extractedValues = [];
      try {
        extractedValues = JSON.parse(jsonArrayString);
      } catch (e) {
        throw new Error("AI failed to return a valid JSON array for dynamic fields.");
      }

      let generatedHtml = fs.readFileSync(tempFilePath, 'utf-8');
      const extractedFields = {};
      
      for (const field of extractedValues) {
        const varName = field.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        // Escape special regex characters in the extracted text
        const escapedField = field.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
        const regex = new RegExp(escapedField, 'g');
        
        if (regex.test(generatedHtml)) {
           generatedHtml = generatedHtml.replace(regex, `{{${varName}}}`);
           extractedFields[varName] = "string";
        }
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
      // 6. Delete the temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          console.log(`[AI Template Worker] Cleaned up file ${tempFilePath}`);
        } catch (err) {
          console.error(`[AI Template Worker] Failed to delete file ${tempFilePath}:`, err.message);
        }
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[AI Template Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[AI Template Worker] Job ${job?.id} failed:`, err));
