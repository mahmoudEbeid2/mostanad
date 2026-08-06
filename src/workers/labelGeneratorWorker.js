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

async function callGeminiWithRetry(model, requestParams, retries = 5, delay = 5000) {
  while (retries > 0) {
    try {
      return await model.generateContent(requestParams);
    } catch (error) {
      const msg = error.message || "";
      const isQuotaOrDemand = msg.includes("503") || msg.includes("Service Unavailable") || msg.includes("429") || msg.includes("quota");
      if (isQuotaOrDemand) {
        console.warn(`[Label Generator] Gemini API busy (503/429). Retrying in ${delay}ms... (retries left: ${retries - 1})`);
        retries--;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.floor(delay * 1.5);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Gemini API failed after all retries due to high demand.");
}

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
        const extractResult = await callGeminiWithRetry(model, extractPrompt);
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
      let matchTier = "none"; // "ingredient_match" | "country_match" | "generic" | "none"
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
          referenceLabels = priority1.slice(0, 1); // Only need 1 ground truth to save tokens
          matchTier = "ingredient_match";
        } else if (priority3.length > 0) {
          console.log(`[Label Generator] Found ${priority3.length} references (Priority 3: Same ingredient globally)`);
          referenceLabels = priority3.slice(0, 1); // Only need 1 ground truth
          matchTier = "ingredient_match";
        } else if (priority2.length > 0) {
          console.log(`[Label Generator] Found ${priority2.length} references (Priority 2: Same country)`);
          referenceLabels = priority2.slice(0, 1); // Only need 1 for formatting
          matchTier = "country_match";
        } else if (allRefs.length > 0) {
          console.log(`[Label Generator] Falling back to generic global references.`);
          referenceLabels = allRefs.slice(0, 1);
          matchTier = "generic";
        }
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: DB search error`, err);
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
        contextDocs += "=== APPROVED REFERENCE LABELS ===\n";
        referenceLabels.forEach((ref, index) => {
          contextDocs += `--- Reference Label ${index + 1}: ${ref.name} ---\n`;
          if (ref.extractedData) {
            contextDocs += `Structured Data: ${JSON.stringify(ref.extractedData, null, 2)}\n`;
          } else if (ref.fullText) {
            // Only send fullText if structured data is missing to save tokens
            contextDocs += `Full Text: ${ref.fullText.substring(0, 1000)}...\n\n`;
          }
        });
      }

      let sourcingInstruction;
      if (matchTier === "ingredient_match") {
        sourcingInstruction = `
      SOURCE OF TRUTH — STRICT GROUNDED MODE (An exact reference for this active ingredient is provided):
      You MUST strictly copy the factual data from the Reference Label for 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse', and 'storage'.
      - DO NOT invent, hallucinate, or add any target animal species that are not in the reference (e.g., do NOT add Poultry if the reference only says Cows/Sheep).
      - DO NOT add extra indications or uses (e.g., do NOT add respiratory support if the reference only mentions urinary).
      - PRESERVE the exact dosage numbers and percentages from the reference.
      - Your job is merely to format, translate, and structure the reference data to match the requested premium JSON schema.
      `;
      } else if (matchTier === "country_match" || matchTier === "generic") {
        sourcingInstruction = `
      SOURCE OF TRUTH — NO DIRECT INGREDIENT MATCH (the references above are NOT for this same active ingredient; they only show formatting/tone/structure conventions):
      Do NOT copy factual content (species, dosages, indications) from these references — they are for a different active ingredient. Use them ONLY as a style/format/phrasing guide.
      For 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse', and 'storage', rely on standard, well-established veterinary/regulatory knowledge for THIS specific active ingredient. Be conservative: only list target species and claims that are well-established for this ingredient, do not pad the list with unrelated species (e.g. do not add poultry to a ruminant-only product) or unrelated claims.
      `;
      } else {
        sourcingInstruction = `
      SOURCE OF TRUTH — NO REFERENCES AVAILABLE:
      No approved reference labels exist yet for this ingredient. Rely on standard, well-established veterinary/regulatory knowledge for THIS specific active ingredient. Be conservative: only list target species and claims that are well-established for this ingredient, do not invent unrelated species or claims.
      `;
      }

      const generationPrompt = `
      You are an elite regulatory affairs specialist, veterinary expert, and pharmaceutical label designer.
      Your task is to generate a highly professional, compliant label text for a product based on its formulation.

      Target Country / Regulatory Body: ${country}
      Target Language: ${language}
      CRITICAL REQUIREMENT: Pharmaceutical labels MUST be bilingual. Every single text field MUST provide both English ("en") and the Target Language ("target") side-by-side.

      ${contextDocs}

      Input Formulation & Details (MAY BE INCOMPLETE). Anything explicitly stated here always wins over any reference or general knowledge:
      ${formulationText}

      ${sourcingInstruction}

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

      const genResult = await callGeminiWithRetry(model, {
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
