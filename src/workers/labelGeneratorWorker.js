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

      // Step 2: Search Reference Labels (Smart Fallback Logic)
      console.log(`[Label Generator] Task ${taskId}: Searching reference labels...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 50, message: "Searching database for similar approved labels..." });
      let referenceLabels = [];
      try {
        const allRefs = await prisma.referenceLabel.findMany({
          orderBy: { createdAt: 'desc' }
        });

        const targetCountry = (country || "").toLowerCase();
        
        let priority1 = []; // Same country + same ingredient
        let priority2 = []; // Same country
        let priority3 = []; // Same ingredient globally
        
        allRefs.forEach(ref => {
          if (!ref.extractedData && !ref.fullText) return;
          const dataStr = JSON.stringify(ref.extractedData || {}).toLowerCase() + " " + (ref.fullText || "").toLowerCase();
          const refCountry = (ref.country || "").toLowerCase();
          
          let hasIngredient = false;
          for (const ing of activeIngredientsList) {
            if (dataStr.includes(ing)) {
              hasIngredient = true;
              break;
            }
          }
          
          if (refCountry === targetCountry && hasIngredient) {
            priority1.push(ref);
          } else if (refCountry === targetCountry) {
            priority2.push(ref);
          } else if (hasIngredient) {
            priority3.push(ref);
          }
        });

        // Resolve Fallback
        if (priority1.length > 0) {
          console.log(`[Label Generator] Found ${priority1.length} references (Priority 1: Same country + ingredient)`);
          referenceLabels = priority1.slice(0, 3);
        } else if (priority2.length > 0) {
          console.log(`[Label Generator] Found ${priority2.length} references (Priority 2: Same country)`);
          referenceLabels = priority2.slice(0, 3);
        } else if (priority3.length > 0) {
          console.log(`[Label Generator] Found ${priority3.length} references (Priority 3: Same ingredient globally)`);
          referenceLabels = priority3.slice(0, 3);
        } else if (allRefs.length > 0) {
          console.log(`[Label Generator] Falling back to generic global references.`);
          referenceLabels = allRefs.slice(0, 2);
        }
      // Step 2.5: Search EDA Requirements
      let edaRequirementsText = "";
      try {
        const edaReqs = await prisma.edaRequirement.findMany({
          where: { country: { equals: country, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
          take: 1
        });
        if (edaReqs.length > 0 && edaReqs[0].extractedText) {
          edaRequirementsText = edaReqs[0].extractedText;
          console.log(`[Label Generator] Found EDA Requirements for ${country}`);
        }
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: EDA search error`, err);
      }


      // Step 3: Final Generation
      console.log(`[Label Generator] Task ${taskId}: Generating final label text...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 70, message: "Writing AI Label text in target language..." });
      
      let contextDocs = "";
      if (edaRequirementsText) {
        contextDocs += `\n\n=== STRICT REGULATORY AUTHORITY REQUIREMENTS (${country}) ===\n`;
        contextDocs += `${edaRequirementsText}\n\n`;
      }
      if (referenceLabels.length > 0) {
        contextDocs += "=== APPROVED REFERENCE LABELS (FOR MISSING DATA & FORMATTING) ===\n";
        contextDocs += "Use these references to accurately determine the 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse', and 'storage' if they are not explicitly provided in the input formulation.\n\n";
        referenceLabels.slice(0, 3).forEach((ref, index) => {
          contextDocs += `--- Reference Label ${index + 1}: ${ref.name} ---\n`;
          if (ref.extractedData) contextDocs += `Structured Data: ${JSON.stringify(ref.extractedData, null, 2)}\n`;
          if (ref.fullText) contextDocs += `Full Text: ${ref.fullText.substring(0, 1500)}...\n\n`;
        });
      }

      const generationPrompt = `
      You are an elite regulatory affairs specialist, veterinary expert, and pharmaceutical label designer.
      Your task is to generate a highly professional, compliant label text for a product based on its formulation.
      
      Target Country / Regulatory Body: ${country}
      Target Language: ${language} 
      CRITICAL REQUIREMENT: Pharmaceutical labels MUST be bilingual. Every single text field MUST provide both English ("en") and the Target Language ("target") side-by-side.
      
      ${contextDocs}
      
      Input Formulation & Details (MAY BE INCOMPLETE):
      ${formulationText}
      
      EXPERT INSTRUCTION:
      If the Input Formulation is brief (e.g. it only provides the active ingredient like "Ammonium Chloride 1000 gm" and packaging), you MUST act as the veterinary expert. Use the provided APPROVED REFERENCE LABELS to intelligently infer the standard 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse' (dosage per species), and 'storage' for this specific ingredient. DO NOT leave them empty.
      
      CRITICAL FORMATTING REQUIREMENTS ("شغل فاخر"):
      You MUST output the result as a strict, valid JSON object. Do NOT write any conversational text or markdown code blocks around the JSON.
      The JSON object MUST follow this exact premium schema. Translate accurately into the target language. Use robust, scientific terminology:

      {
        "productName": { "en": "Name in English", "target": "Name in Target Language" },
        "feedClassification": { "en": "e.g. Feed Additive (Non-Medicated)", "target": "e.g. إضافة علفية غير دوائية" },
        "ingredients": [
          { "en": "Ingredient in English", "target": "Ingredient in Target Language", "amount": "e.g. 1000 gm" }
        ],
        "aimOfUse": { "en": "Indications in English", "target": "Indications in Target Language" },
        "targetAnimalSpecies": { "en": "e.g. Cow - Buffalo - Sheep", "target": "الأبقار - الجاموس - الأغنام" },
        "directionOfUse": { "en": "Dosage instructions in English", "target": "Dosage instructions in Target Language" },
        "storage": { "en": "Storage conditions in English", "target": "Storage conditions in Target Language" },
        "netWeight": { "en": "e.g. 25 kg", "target": "e.g. 25 كجم" },
        "mandatoryFields": {
          "forAnimalFeedPlant": true,
          "manufacturer": true,
          "importer": true,
          "countryOfProduction": true,
          "batchNo": true,
          "productionDate": true,
          "expiryDate": true
        }
      }
      `;

      const genResult = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: generationPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      });
      let generatedJson = {};
      try {
        generatedJson = JSON.parse(genResult.response.text());
      } catch (err) {
        console.error("Failed to parse JSON from AI", err);
        throw new Error("AI returned invalid data format.");
      }

      // Step 4: Save Result
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { 
          status: "completed",
          result: generatedJson
        }
      });
      
      socket.emit("job_status_update", { jobId: taskId, status: "completed", progress: 100, result: generatedJson, message: "Label generated successfully!" });
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
