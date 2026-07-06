import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
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
    try {
      if (!fileBufferBase64) {
        throw new Error(`Uploaded design file buffer is missing`);
      }

      // Write the buffer to a temp file within this worker container
      const tempFileName = `ai_design_${Date.now()}_${Math.random().toString(36).substring(7)}_${fileName}`;
      tempFilePath = path.join(process.cwd(), tempFileName);
      fs.writeFileSync(tempFilePath, Buffer.from(fileBufferBase64, 'base64'));

      // 2. Process HTML generation
      let generatedHtml = await generateHtmlFromDesign(
        tempFilePath,
        fileName,
        mimeType
      );

      // 2.5 Convert to Background Image using ImageMagick
      const uploadsDesignsDir = path.join(process.cwd(), "uploads", "designs");
      if (!fs.existsSync(uploadsDesignsDir)) {
        fs.mkdirSync(uploadsDesignsDir, { recursive: true });
      }

      const bgFileName = `bg_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
      const bgFilePath = path.join(uploadsDesignsDir, bgFileName);
      
      const execAsync = promisify(exec);
      try {
        console.log(`[AI Template Worker] Converting ${tempFilePath} to background image...`);
        // We use Ghostscript/ImageMagick to convert the first page to PNG
        await execAsync(`convert -density 150 "${tempFilePath}[0]" -background white -alpha remove -alpha off "${bgFilePath}"`);
        
        const baseUrl = process.env.PUBLIC_BACKEND_URL || "http://localhost:3000";
        const backgroundUrl = `${baseUrl}/uploads/designs/${bgFileName}`;
        console.log(`[AI Template Worker] Successfully generated background image: ${backgroundUrl}`);
        
        // Inject background into the HTML
        // Find the <div class="certificate-wrapper"...> and insert the background
        const bgLayer = `\n<div style="position: absolute; top: 0; left: 0; width: 1000px; height: 1414px; background-image: url('${backgroundUrl}'); background-size: 100% 100%; background-repeat: no-repeat; z-index: -1;"></div>\n`;
        generatedHtml = generatedHtml.replace(/(<div[^>]*class=["']certificate-wrapper["'][^>]*>)/i, `$1${bgLayer}`);
      } catch (convErr) {
        console.error(`[AI Template Worker] Warning: Failed to convert design to background image:`, convErr.message);
        // We do not fail the whole task if background conversion fails, we just log it.
      }

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
