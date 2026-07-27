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
      // Pass directly to Gemini
      const parts = [
        {
          inlineData: {
            data: fileBufferBase64,
            mimeType: mimeType
          }
        },
        { text: "Please carefully read the attached regulatory document. Your goal is to extract a comprehensive list of strict validation rules that a compliance officer would use to check a product label. Extract mandatory fields, prohibited terms, formatting requirements, and storage conditions. If a rule only applies to a specific product type (like 'Feed Additive'), specify it. Do not leave out any critical label requirements." }
      ];

      const systemInstruction = `You are a highly capable regulatory affairs assistant. Your job is to read regulatory documents (e.g., from the EDA or SFDA) and extract STRICT validation rules for checking product labels. Do not extract paragraphs of text. Extract granular, atomic rules that a computer system can use to validate a product label.`;
      
      const schema = {
        type: "array",
        description: "An array of strict label validation rules extracted from the document.",
        items: {
          type: "object",
          properties: {
            targetProductType: { type: "string", description: "The specific product type this rule applies to (e.g., 'All Products', 'Feed Material', 'Compound Feed', 'Premix'). If it applies to everything, write 'All Products'." },
            ruleType: { type: "string", enum: ["Mandatory Field", "Prohibited Claim", "Formatting Rule", "Storage Condition", "General Rule"], description: "The category of the rule." },
            ruleDescription: { type: "string", description: "The exact, clear, and actionable rule that must be enforced on the label." },
            severity: { type: "string", enum: ["CRITICAL", "WARNING"], description: "CRITICAL if violating this causes rejection. WARNING if it's a recommendation." },
            example: { type: "string", description: "An example provided in the text that demonstrates this rule or a valid label sample (optional)." }
          },
          required: ["targetProductType", "ruleType", "ruleDescription", "severity"]
        }
      };

      socket.emit("job_status_update", {
        jobId: taskId,
        status: "processing",
        progress: 50,
        message: "Structuring rules via AI..."
      });

      let extractedData;
      try {
        extractedData = await geminiClient.generateJson({
          model: "gemini-2.5-flash",
          contents: parts,
          systemInstruction,
          schema
        });
      } catch (error) {
        throw new Error("Failed to process document with AI: " + error.message);
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
          extractedText: "Text extracted natively by Gemini",
          extractedData,
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
