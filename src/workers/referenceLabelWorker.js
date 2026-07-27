import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { io } from "socket.io-client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import os from "os";

const redisConfig = getRedisConfig();
const backendWsUrl = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(backendWsUrl);

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY is not set. ReferenceLabelWorker might fail.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

socket.on("connect", () => {
  console.log(`[ReferenceLabelWorker] Connected to WS at ${backendWsUrl} (Socket ID: ${socket.id})`);
});

const referenceLabelWorker = new Worker(
  "referenceLabelQueue",
  async (job) => {
    const { fileName, mimeType, fileBufferBase64, taskId, companyId } = job.data;
    
    console.log(`[ReferenceLabelWorker] Processing reference label task ${taskId} for company ${companyId || 'GLOBAL'}`);
    
    socket.emit("job_status_update", {
      jobId: taskId,
      companyId,
      status: "processing",
      progress: 10,
      message: "Starting AI extraction of reference label..."
    });

    try {
      const fileBuffer = Buffer.from(fileBufferBase64, "base64");
      
      const parts = [
        {
          inlineData: {
            data: fileBuffer.toString("base64"),
            mimeType: mimeType
          }
        }
      ];

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "processing",
        progress: 40,
        message: "Analyzing reference label with AI..."
      });

      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const prompt = `
        You are a regulatory compliance AI assistant analyzing a previously approved product label.
        Your goal is to extract the **Formatting Rules, Style Guide, and Phrasing** used in this approved label, so that future labels can be evaluated against these standards.
        
        Analyze the provided label and extract the following:
        1. "ingredients_format": How are the active ingredients listed? (e.g., tabular, inline, units used, order)
        2. "storage_format": Exactly how are the storage conditions phrased? (e.g., "Store in a cool dry place below 30C")
        3. "dosage_format": How is the dosage/directions of use structured? (e.g., by animal species, table format)
        4. "warnings_and_omissions": Are there specific warnings included? Or notable omissions that are apparently allowed?
        5. "layout_structure": Where are the key elements positioned relatively?

        Return ONLY a raw JSON object with these exactly named keys. Do not include markdown formatting like \`\`\`json.
      `;

      const result = await model.generateContent([prompt, ...parts]);
      const responseText = result.response.text();
      
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "processing",
        progress: 80,
        message: "Parsing AI extraction results..."
      });

      let extractedData = {};
      try {
        const cleanJsonStr = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        extractedData = JSON.parse(cleanJsonStr);
      } catch (err) {
        console.warn("[ReferenceLabelWorker] Failed to parse JSON, saving raw text instead.", err);
        extractedData = { rawResponse: responseText };
      }

      // Save to database
      const referenceLabel = await prisma.referenceLabel.create({
        data: {
          name: fileName,
          companyId: companyId || null,
          extractedData: extractedData
        }
      });

      // Update background task
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          result: referenceLabel
        }
      });

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "completed",
        progress: 100,
        message: "Reference label extracted and saved successfully."
      });

      console.log(`[ReferenceLabelWorker] Successfully processed task ${taskId}`);
      return { success: true, referenceLabelId: referenceLabel.id };

    } catch (error) {
      console.error(`[ReferenceLabelWorker] Error processing task ${taskId}:`, error);

      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "failed",
          error: error.message
        }
      });

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "failed",
        error: error.message
      });

      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 }
);

referenceLabelWorker.on("failed", (job, err) => {
  console.error(`[ReferenceLabelWorker] Job ${job.id} failed with error: ${err.message}`);
});

console.log("👷‍♂️ ReferenceLabelWorker is running and listening for jobs...");
