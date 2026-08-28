import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import io from "socket.io-client";
import geminiClient from "../services/ai/geminiClient.js";
import { MODELS } from "../services/ai/modelRegistry.js";
import * as regulatoryDocumentService from "../services/label/regulatory/regulatoryDocumentService.js";
import AppError from "../utils/appError.js";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[EDA Requirement Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[EDA Requirement Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

// Steps 1-2 of the seven-step ingestion journey (§7.4): upload -> extract full
// text natively from the PDF (never pdf-parse — it destroys the tables that
// carry withdrawal periods and species matrices) -> hash -> refuse a duplicate.
// Steps 3-7 (compile rules, audit coverage, review, approve) are separate
// endpoints (POST /regulatory-documents/:id/compile-rules etc.) — they happen
// once per document, not automatically on every upload.
const worker = new Worker(
  "edaRequirementQueue",
  async (job) => {
    const { country, fileBufferBase64, fileName, mimeType, companyId, title, authority, productScope, sourceUrl, documentVersion } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[EDA Requirement Worker] Starting job ${job.id} (Task ${taskId})`);

    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
    socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 10, message: "Reading document..." });

    try {
      const parts = [
        { inlineData: { data: fileBufferBase64, mimeType } },
        { text: "Please carefully read the attached regulatory document and extract the complete, unabridged text exactly as it is written. Preserve headings, lists, and tables as markdown. Do not summarize." },
      ];

      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 30, message: "Extracting full text..." });

      let fullText = "";
      try {
        fullText = await geminiClient.generateText({
          model: MODELS.EXTRACT.id,
          contents: parts,
          config: { temperature: MODELS.EXTRACT.temperature, thinkingConfig: { thinkingBudget: MODELS.EXTRACT.thinkingBudget } },
        });
      } catch (err) {
        throw new Error("Failed to extract full text: " + err.message);
      }

      if (!fullText || !fullText.trim()) {
        throw new Error("Extraction produced no text — refusing to store an empty regulatory document.");
      }

      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 80, message: "Checking for duplicates and saving..." });

      const document = await regulatoryDocumentService.createFromExtraction({
        title: title || null,
        authority: authority || null,
        country,
        productScope: Array.isArray(productScope) ? productScope : [],
        sourceType: "official_upload",
        sourceUrl: sourceUrl || null,
        documentVersion: documentVersion || null,
        companyId,
        extractedText: fullText,
      });

      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", result: document } });
      socket.emit("job_status_update", { jobId: taskId, status: "completed", progress: 100, message: "Document extracted and stored.", result: document });

      console.log(`[EDA Requirement Worker] Job ${job.id} completed successfully. Document ID: ${document.id}`);
      return document;
    } catch (error) {
      console.error(`[EDA Requirement Worker] Error in job ${job.id}:`, error);

      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "failed", error: error.message },
      });
      socket.emit("job_status_update", { jobId: taskId, status: "failed", error: error.message });

      // A duplicate hash (AppError 409) is an expected, reportable outcome, not a
      // worker crash — but it still needs to fail the task so the caller sees it.
      if (error instanceof AppError) throw error;
      throw error;
    }
  },
  { connection, concurrency: 2 }
);

worker.on("completed", (job) => {
  console.log(`[EDA Requirement Worker] BullMQ job ${job.id} marked as completed.`);
});

worker.on("failed", (job, err) => {
  console.error(`[EDA Requirement Worker] BullMQ job ${job.id} failed with error: ${err.message}`);
});

export default worker;
