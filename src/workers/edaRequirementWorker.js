import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import io from "socket.io-client";
import geminiClient from "../services/ai/geminiClient.js";


const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[EDA Requirement Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

socket.on("connect_error", (err) => {
  console.error(`[EDA Requirement Worker] Socket connection error: ${err.message}`);
});

const connection = getRedisConfig();

const worker = new Worker(
  "edaRequirementQueue",
  async (job) => {
    const { country, fileBufferBase64, fileName, mimeType, companyId } = job.data;
    const taskId = job.opts.jobId;

    console.log(`[EDA Requirement Worker] Starting job ${job.id} (Task ${taskId})`);

    // 1. Update DB task status to processing
    await prisma.backgroundTask.update({
      where: { id: taskId },
      data: { status: "processing" },
    });

    // Notify status via ws
    socket.emit("job_status_update", {
      jobId: taskId,
      status: "processing",
      progress: 10,
      message: "Parsing document text locally..."
    });

    try {
      const parts1 = [
        {
          inlineData: {
            data: fileBufferBase64,
            mimeType: mimeType
          }
        },
        { text: "Please carefully read the attached regulatory document and extract the complete, unabridged text exactly as it is written. Preserve headings, lists, and tables as markdown. Do not summarize." }
      ];

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "processing",
        progress: 30,
        message: "Extracting raw text from document..."
      });

      const model = geminiClient.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      let fullText = "";
      try {
        const textResult = await model.generateContent(parts1);
        fullText = textResult.response.text();
      } catch (err) {
        throw new Error("Failed to extract full text: " + err.message);
      }

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "processing",
        progress: 60,
        message: "Analyzing and extracting strict rules..."
      });

      const parts2 = [
        { text: `Here is the full text of a regulatory document. Please extract a comprehensive list of strict validation rules that a compliance officer would use to check a product label.\n\nDocument Text:\n${fullText}` }
      ];

      const systemInstruction = `You are a highly capable regulatory affairs assistant. Extract STRICT validation rules for checking product labels from the provided text.`;
      
      const schema = {
        type: "array",
        description: "An array of strict label validation rules extracted from the document.",
        items: {
          type: "object",
          properties: {
            targetProductType: { type: "string", description: "The specific product type this rule applies to" },
            ruleType: { type: "string", enum: ["Mandatory Field", "Prohibited Claim", "Formatting Rule", "Storage Condition", "General Rule"] },
            ruleDescription: { type: "string", description: "The exact, clear, and actionable rule." },
            severity: { type: "string", enum: ["CRITICAL", "WARNING"] },
            example: { type: "string" }
          },
          required: ["targetProductType", "ruleType", "ruleDescription", "severity"]
        }
      };

      let extractedRules = [];
      try {
        extractedRules = await geminiClient.generateJson({
          model: "gemini-2.5-flash",
          contents: parts2,
          systemInstruction,
          schema
        });
      } catch (error) {
        console.warn("[EDA Requirement Worker] Failed to extract JSON rules. Saving full text only.", error.message);
      }

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "processing",
        progress: 90,
        message: "AI processing complete. Saving to database..."
      });

      const requirement = await prisma.edaRequirement.create({
        data: {
          country,
          companyId,
          extractedText: fullText || "Full text extraction failed.",
          extractedData: extractedRules || [],
        }
      });

      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "completed", result: requirement },
      });

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "completed",
        progress: 100,
        message: "Requirement successfully processed and stored.",
        result: requirement
      });

      console.log(`[EDA Requirement Worker] Job ${job.id} completed successfully.`);
      return requirement;
    } catch (error) {
      console.error(`[EDA Requirement Worker] Error in job ${job.id}:`, error);
      
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "failed", error: error.message },
      });

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "failed",
        error: error.message,
      });

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
