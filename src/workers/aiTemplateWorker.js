import fs from "fs";
import path from "path";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
// import removed
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

      const tempFileName = `ai_design_${Date.now()}_${Math.random().toString(36).substring(7)}_${fileName}`;
      tempFilePath = path.join(process.cwd(), tempFileName);
      fs.writeFileSync(tempFilePath, Buffer.from(fileBufferBase64, 'base64'));

      let svgFilePath = tempFilePath;
      let cleanupFiles = [tempFilePath];

      const { execSync } = await import("child_process");

      if (!fileName.toLowerCase().endsWith('.svg')) {
          svgFilePath = `${tempFilePath}.svg`;
          cleanupFiles.push(svgFilePath);
          console.log(`[AI Template Worker] Converting ${fileName} to SVG using Inkscape...`);
          execSync(`inkscape --export-type=svg --export-text-to-path=false --export-filename="${svgFilePath}" "${tempFilePath}"`);
      }

      // Convert SVG to PNG for AI OCR to avoid 1M token limit crash from large SVGs
      let pngFilePath = `${tempFilePath}.png`;
      cleanupFiles.push(pngFilePath);
      console.log(`[AI Template Worker] Creating PNG preview for AI OCR...`);
      execSync(`inkscape --export-type=png --export-filename="${pngFilePath}" --export-dpi=150 "${svgFilePath}"`);

      // 2. Run the Multi-Stage AI Pipeline
      const { default: aiTemplatePipeline } = await import('../services/ai/pipeline.js');
      const pipelineResult = await aiTemplatePipeline.runPipeline(pngFilePath, svgFilePath);
      
      const finalHtml = pipelineResult.finalHtml;
      const extractedFields = pipelineResult.extractedFields;

<<<<<<< Updated upstream

      // 3. Create the template in database
      const newTemplate = await prisma.template.create({
        data: {
          name: templateName || "AI Generated Template",
          type: "certificate", // default
          companyId,
          brandId: brandId || null,
          isGlobal: false,
          fields: extractedFields,
          htmlContent: finalHtml,
          isActive: true
        }
      });

      // 4. Update DB task status to completed
=======
      // Extract dynamic fields to populate requiredFields
      const extractedFields = {};
      const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
      let match;
      while ((match = regex.exec(generatedHtml)) !== null) {
        extractedFields[match[1]] = "string";
      }
      // 3. Update DB task status to completed
>>>>>>> Stashed changes
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
<<<<<<< Updated upstream
          result: { templateId: newTemplate.id, html: finalHtml },
=======
          result: { htmlContent: generatedHtml, fields: extractedFields },
>>>>>>> Stashed changes
        },
      });

      // 4. Broadcast success
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        brandId,
        type: "ai_template_generation",
        status: "completed",
        result: { htmlContent: generatedHtml, fields: extractedFields },
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
      // 6. Delete the temp files
      if (typeof cleanupFiles !== 'undefined' && Array.isArray(cleanupFiles)) {
        for (const file of cleanupFiles) {
          if (file && fs.existsSync(file)) {
            try {
              fs.unlinkSync(file);
              console.log(`[AI Template Worker] Cleaned up file ${file}`);
            } catch (err) {
              console.error(`[AI Template Worker] Failed to delete file ${file}:`, err.message);
            }
          }
        }
      } else if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {}
      }
    }
  },
  { connection }
);

worker.on("ready", () => console.log("[AI Template Worker] BullMQ worker is ready."));
worker.on("failed", (job, err) => console.error(`[AI Template Worker] Job ${job?.id} failed:`, err));
