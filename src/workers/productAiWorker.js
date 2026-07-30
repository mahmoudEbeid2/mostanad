import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { io } from "socket.io-client";
import { GoogleGenerativeAI } from "@google/generative-ai";

const redisConfig = getRedisConfig();
const backendWsUrl = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(backendWsUrl);

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY is not set. ProductAiWorker might fail.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

socket.on("connect", () => {
  console.log(`[ProductAiWorker] Connected to WS at ${backendWsUrl} (Socket ID: ${socket.id})`);
});

const productAiWorker = new Worker(
  "productAiQueue",
  async (job) => {
    const { rawText, companyId, brandId, categoryId, taskId } = job.data;
    
    console.log(`[ProductAiWorker] Processing task ${taskId} for company ${companyId}`);
    
    socket.emit("job_status_update", {
      jobId: taskId,
      companyId,
      status: "processing",
      progress: 20,
      message: "Analyzing product details..."
    });

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const prompt = `
        You are a regulatory compliance assistant. Extract the product details from the following raw text into a strict JSON format matching exactly this Prisma schema:
        
        {
          "name": "String (required)",
          "productCode": "String (optional)",
          "description": "String (optional)",
          "indications": "String (optional)",
          "targetSpecies": ["Array of Strings"] (optional),
          "physicalForm": "String (optional)",
          "appearance": "String (optional)",
          "activeIngredients": [{"name": "String", "concentration": "String"}] (optional),
          "dosage": "String (optional)",
          "mixingInstructions": "String (optional)",
          "withdrawalPeriod": "String (optional)",
          "contraindications": "String (optional)",
          "userSafety": ["Array of Strings"] (optional),
          "storage": "String (optional)",
          "packaging": "String (optional)",
          "registrationNumber": "String (optional)",
          "origin": "String (optional)",
          "producer": "String (optional)"
        }

        Only include fields you can confidently deduce from the text. For arrays, split items logically. For active ingredients, structure as an array of objects.
        
        Raw Text:
        """
        ${rawText}
        """
        
        Return ONLY valid JSON. Do not include markdown blocks like \`\`\`json.
      `;

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "processing",
        progress: 50,
        message: "Generating structured data with AI..."
      });

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "processing",
        progress: 80,
        message: "Saving product to database..."
      });

      let extractedData = {};
      try {
        const cleanJsonStr = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        extractedData = JSON.parse(cleanJsonStr);
      } catch (err) {
        throw new Error("AI returned invalid JSON format.");
      }

      // Check for unique name conflict
      if (extractedData.name) {
        const existing = await prisma.product.findUnique({
          where: { name: extractedData.name }
        });
        if (existing) {
          extractedData.name = extractedData.name + " (AI Extracted " + Date.now().toString().slice(-4) + ")";
        }
      } else {
        extractedData.name = "Unknown Product " + Date.now().toString().slice(-4);
      }

      // Create product
      const product = await prisma.product.create({
        data: {
          ...extractedData,
          companyId,
          brandId: brandId || null,
          categoryId: categoryId || null
        }
      });

      // Update background task
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          result: product
        }
      });

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: "completed",
        progress: 100,
        message: "Product created successfully."
      });

      console.log(`[ProductAiWorker] Successfully processed task ${taskId}`);
      return { success: true, productId: product.id };

    } catch (error) {
      console.error(`[ProductAiWorker] Error processing task ${taskId}:`, error);

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

productAiWorker.on("failed", (job, err) => {
  console.error(`[ProductAiWorker] Job ${job.id} failed with error: ${err.message}`);
});

console.log("👷‍♂️ ProductAiWorker is running and listening for jobs...");
