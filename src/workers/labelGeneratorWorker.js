import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import io from "socket.io-client";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Generator Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

const connection = getRedisConfig();

/**
 * labelGeneratorWorker
 */
export const labelGeneratorWorker = new Worker(
  "labelGeneratorQueue",
  async (job) => {
    const { taskId, formulationText, country, language } = job.data;
    
    console.log(`[Label Generator] Started task: ${taskId} for Country: ${country}, Language: ${language}`);

    try {
      // Notify starting
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "processing" }
      });
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 10, message: "Extracting active ingredients..." });

      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      // Step 1: Extract Active Ingredients
      console.log(`[Label Generator] Task ${taskId}: Extracting active ingredients...`);
      const extractPrompt = `
      You are a pharmaceutical expert. Extract the primary active ingredients from the following product formulation text.
      Return ONLY a comma-separated list of the ingredient names.
      Do not include concentrations, dosages, or any other text.
      
      Formulation Text:
      ${formulationText}
      `;

      let activeIngredientsList = [];
      try {
        const extractResult = await model.generateContent(extractPrompt);
        const extractText = extractResult.response.text();
        activeIngredientsList = extractText.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        console.log(`[Label Generator] Task ${taskId}: Found ingredients:`, activeIngredientsList);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 30, message: `Found ingredients: ${activeIngredientsList.join(", ")}` });
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: Extraction failed.`, err);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 30, message: `Extraction failed, proceeding with generic search.` });
      }

      // Step 2: Search Reference Labels
      console.log(`[Label Generator] Task ${taskId}: Searching reference labels...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 50, message: "Searching database for similar approved labels..." });
      let referenceLabels = [];
      try {
        const allRefs = await prisma.referenceLabel.findMany({
          take: 100,
          orderBy: { createdAt: 'desc' }
        });

        referenceLabels = allRefs.filter(ref => {
          if (!ref.extractedData) return false;
          const dataStr = JSON.stringify(ref.extractedData).toLowerCase();
          
          if (dataStr.includes(country.toLowerCase())) return true;
          
          for (const ing of activeIngredientsList) {
            if (dataStr.includes(ing)) return true;
          }
          return false;
        });

        if (referenceLabels.length === 0 && allRefs.length > 0) {
          referenceLabels = allRefs.slice(0, 5);
        }
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: DB search error`, err);
      }

      // Step 3: Final Generation
      console.log(`[Label Generator] Task ${taskId}: Generating final label text...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 70, message: "Writing AI Label text in target language..." });
      
      let contextDocs = "";
      if (referenceLabels.length > 0) {
        contextDocs = "Here are some examples of APPROVED reference labels and their extracted rules from our database to guide your formatting and compliance:\n\n";
        referenceLabels.slice(0, 5).forEach((ref, index) => {
          contextDocs += `--- Reference Label ${index + 1}: ${ref.name} ---\n`;
          contextDocs += `${JSON.stringify(ref.extractedData, null, 2)}\n\n`;
        });
      }

      const generationPrompt = `
      You are an elite regulatory affairs specialist and pharmaceutical label generator.
      Your task is to generate a highly professional, compliant label text for a product based on its formulation.
      
      Target Country / Regulatory Body: ${country}
      Target Language: ${language}
      
      ${contextDocs}
      
      Input Formulation & Details:
      ${formulationText}
      
      Requirements:
      1. Use the Target Language (${language}) for the output text.
      2. Adhere to the formatting and regulatory style expected by ${country}'s authorities (e.g., FDA, EDA, etc.).
      3. Organize the text cleanly using Markdown (Headers, bullet points, bold text).
      4. Ensure all necessary sections for a pharmaceutical/veterinary label are present (e.g., Active Ingredients, Indications, Dosage, Contraindications, Warnings, Storage, etc.).
      5. Do NOT include generic conversational text like "Here is the label". Just return the Markdown label text directly.
      `;

      const genResult = await model.generateContent(generationPrompt);
      const generatedText = genResult.response.text();

      // Step 4: Save Result
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { 
          status: "completed",
          result: {
             generatedText: generatedText
          }
        }
      });
      
      socket.emit("job_status_update", { jobId: taskId, status: "completed", progress: 100, result: { generatedText }, message: "Label text generated successfully!" });
      console.log(`[Label Generator] Task ${taskId} completed successfully.`);

    } catch (error) {
      console.error(`[Label Generator] Job failed:`, error);
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { 
          status: "failed",
          error: error.message || "Unknown error occurred"
        }
      });
      socket.emit("job_status_update", { jobId: taskId, status: "failed", progress: 0, error: error.message, message: error.message });
      throw error;
    }
  },
  { 
    connection,
    concurrency: 2
  }
);

labelGeneratorWorker.on("completed", (job) => {
  console.log(`Job ${job.id} has completed!`);
});

labelGeneratorWorker.on("failed", (job, err) => {
  console.log(`Job ${job.id} has failed with ${err.message}`);
});

console.log("[Label Generator Worker] Started listening to labelGeneratorQueue...");
