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
    const { country, fileBufferBase64, fileName, mimeType } = job.data;
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
        { text: "Please carefully read the attached regulatory document. Structure and categorize all the rules, conditions, and requirements into logical sections. Do not leave out any important conditions. Ensure the text is clean and professional." }
      ];

      const systemInstruction = `You are a highly capable regulatory affairs assistant analyzing Egyptian Drug Authority (EDA) documents or other regulatory requirements.`;
      
      const schema = {
        type: "array",
        description: "An array of structured requirement sections.",
        items: {
          type: "object",
          properties: {
            section: { type: "string", description: "The title of the section or category (e.g., General Conditions, Required Documents, Formatting Rules)." },
            content: { type: "string", description: "The detailed extracted rules or text belonging to this section." }
          },
          required: ["section", "content"]
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
