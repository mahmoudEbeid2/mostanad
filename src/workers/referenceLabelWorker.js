import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { io } from "socket.io-client";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
    const {
      fileName,
      mimeType,
      fileBufferBase64,
      taskId,
      companyId,
      brandId,
      country,
      categoryId,
      manualCategoryName,
    } = job.data;
    
    console.log(`[ReferenceLabelWorker] Processing reference label task ${taskId} for company ${companyId || 'GLOBAL'} and brand ${brandId || 'GLOBAL'}`);
    
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

      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const prompt = `
        You are a regulatory compliance AI assistant analyzing a previously approved product label.
        Your goal is to extract the full text and convert the approved label into reusable regulatory/style guidance for future labels.
        Accepted country provided by the user: ${country || "Unknown"}.
        Product category context: ${manualCategoryName || "None provided. You MUST analyze the active ingredients and composition to accurately infer and classify the product category (e.g., Antibiotic, Vitamin Supplement, Anti-inflammatory, Feed Additive, etc.)."}
        
        Return a raw JSON object with these exact top-level keys:
        1. "full_text": the complete readable label text in natural order. Preserve headings and important wording.
        2. "accepted_country": the country this reference is accepted in.
        3. "category_hint": the product category based on context or inferred from ingredients. MUST NOT be null if you can infer it.
        4. "sections": object containing arrays/strings for "ingredients", "composition", "indications", "dosage", "warnings", "storage", "withdrawal_period", "manufacturer", "registration", "claims", "other".
        5. "style_guide": object describing ingredients_format, storage_format, dosage_format, warnings_format, language_tone, and layout_structure.
        6. "regulatory_notes": array of notable compliance patterns, required-looking statements, allowed omissions, or country-specific phrasing.

        Return ONLY a raw JSON object. Do not include markdown formatting like \`\`\`json.
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
      let fullText = null;
      try {
        const cleanJsonStr = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        extractedData = JSON.parse(cleanJsonStr);
        fullText = typeof extractedData.full_text === "string" ? extractedData.full_text : null;
      } catch (err) {
        console.warn("[ReferenceLabelWorker] Failed to parse JSON, saving raw text instead.", err);
        extractedData = { rawResponse: responseText };
        fullText = responseText;
      }

      // Save to database
      const referenceLabel = await prisma.referenceLabel.create({
        data: {
          name: fileName,
          companyId: companyId || null,
          brandId: brandId || null,
          categoryId: categoryId || null,
          manualCategoryName: manualCategoryName || extractedData.category_hint || null,
          country: country || extractedData.accepted_country || null,
          sourceType: "upload",
          fullText,
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
        message: "Label extraction complete!",
        result: { referenceLabelId: referenceLabel.id }
      });

      // Add a 6-second delay to avoid hitting Gemini 15 RPM Free Tier Rate Limits
      // Since BullMQ processes sequentially (concurrency=1), this spaces out API calls.
      await new Promise(resolve => setTimeout(resolve, 6000));

      console.log(`[ReferenceLabelWorker] Successfully processed task ${taskId}`);
      return { success: true, referenceLabelId: referenceLabel.id };

    } catch (error) {
      console.error(`[ReferenceLabelWorker] Job ${job.id} failed:`, error);
      
      const isRetrying = job.attemptsMade < job.opts.attempts - 1;
      const isRateLimit = error.message?.includes("429");

      if (!isRetrying) {
        await prisma.backgroundTask.update({
          where: { id: taskId },
          data: {
            status: "failed",
            error: error.message || "Unknown error",
          },
        });
      }

      socket.emit("job_status_update", {
        jobId: taskId,
        companyId,
        status: isRetrying ? "processing" : "failed",
        progress: 0,
        message: isRetrying 
          ? (isRateLimit ? "AI rate limit reached. Waiting to retry..." : "Error occurred. Retrying shortly...") 
          : "Task failed.",
        error: isRetrying ? null : error.message || "Failed to process label",
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
