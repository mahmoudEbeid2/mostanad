import { withAiJobContext } from "../services/ai/aiContext.js";
import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import io from "socket.io-client";
import { geminiWorkerName } from "../services/ai/geminiGuard.js";
import { extractTextAndCatalog } from "../services/label/regulatory/catalogExtractor.js";
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

// §0/§2 of the ingestion overhaul: upload -> extract text+catalog in ONE
// Gemini call (native PDF, never pdf-parse) -> hash -> refuse a duplicate ->
// compile rules -> audit coverage -> activate. ALL of it automatic, no human
// gate on ingestion — see regulatoryDocumentService.ingestAutomatically for
// why compile/audit stay separate Gemini calls with their own full context
// budget rather than folded into this one. The existing manual endpoints
// (POST .../compile-rules, .../audit-coverage, .../approve) remain for
// re-running a single stage; nothing depends on a human pressing them.
const worker = new Worker(
  "edaRequirementQueue",
  // AI cost ledger: every Gemini call this job makes is billed to its company/user
  (job) => withAiJobContext(job, async () => {
    const { country, fileBufferBase64, fileName, mimeType, companyId, title, authority, productScope, sourceUrl, documentVersion } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[EDA Requirement Worker] Starting job ${job.id} (Task ${taskId})`);

    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "processing" } });
    socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 10, message: "Reading document and building label-field catalog..." });

    try {
      let text, catalog;
      try {
        ({ text, catalog } = await extractTextAndCatalog(
          { inlineData: { data: fileBufferBase64, mimeType } },
          { title, authority, country }
        ));
      } catch (err) {
        throw new Error("Failed to extract text/catalog: " + err.message);
      }

      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 40, message: "Checking for duplicates and saving..." });

      const document = await regulatoryDocumentService.createFromExtraction({
        title: title || null,
        authority: authority || null,
        country,
        productScope: Array.isArray(productScope) ? productScope : [],
        sourceType: "official_upload",
        sourceUrl: sourceUrl || null,
        documentVersion: documentVersion || null,
        companyId,
        extractedText: text,
        labelFieldSchema: catalog,
      });

      socket.emit("job_status_update", { jobId: taskId, companyId, status: "processing", progress: 60, message: "Compiling rules, auditing coverage, and activating..." });

      const activated = await regulatoryDocumentService.ingestAutomatically(document.id);

      await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "completed", result: activated } });
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "completed", progress: 100, message: `Document ingested and activated (${activated.activationMode} severity).`, result: activated });

      console.log(`[EDA Requirement Worker] Job ${job.id} completed successfully. Document ID: ${activated.id} (activationMode: ${activated.activationMode})`);
      return activated;
    } catch (error) {
      console.error(`[EDA Requirement Worker] Error in job ${job.id}:`, error);

      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "failed", error: error.message },
      });
      socket.emit("job_status_update", { jobId: taskId, companyId, status: "failed", error: error.message });

      // A duplicate hash (AppError 409) is an expected, reportable outcome, not a
      // worker crash — but it still needs to fail the task so the caller sees it.
      if (error instanceof AppError) throw error;
      throw error;
    }
  }),
  { connection, concurrency: 2, name: geminiWorkerName("edaRequirementQueue") }
);

worker.on("completed", (job) => {
  console.log(`[EDA Requirement Worker] BullMQ job ${job.id} marked as completed.`);
});

worker.on("failed", (job, err) => {
  console.error(`[EDA Requirement Worker] BullMQ job ${job.id} failed with error: ${err.message}`);
});

export default worker;
