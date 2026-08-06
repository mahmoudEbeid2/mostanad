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
    const { taskId, formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint } = job.data;
    
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

      // Step 2.5: Search EDA Requirements (stored in DB first, then fall back to a live web search)
      let edaRequirementsText = "";
      try {
        const edaReqs = await prisma.edaRequirement.findMany({
          where: { country: { equals: country, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
          take: 1
        });
        if (edaReqs.length > 0 && edaReqs[0].extractedText) {
          edaRequirementsText = edaReqs[0].extractedText;
          console.log(`[Label Generator] Found stored EDA Requirements for ${country}`);
        }
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: EDA search error`, err);
      }

      // Step 2.6: Nothing on file for this country — search the web once via Gemini grounding
      // and cache the result so future generations for this country reuse it instead of re-searching.
      if (!edaRequirementsText) {
        console.log(`[Label Generator] Task ${taskId}: No stored requirements for ${country}. Searching the web...`);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 55, message: `Searching the web for ${country}'s official feed labeling requirements...` });

        try {
          const searchModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: [{ google_search: {} }]
          });

          const searchPrompt = `
          Use Google Search to find the CURRENT, OFFICIAL animal feed / veterinary product labeling requirements published by the official food & drug or agriculture regulatory authority of "${country}" (e.g. their food/drug authority, ministry of agriculture, or veterinary directorate).

          I need: mandatory label fields/sections, required bilingual/language rules, controlled vocabulary for product classification and target species naming, prohibited claim types (e.g. therapeutic/medical claims on non-medicated feed), and any mandatory closing declarations.

          Respond with ONLY a raw JSON object (no markdown):
          {
            "found": true or false,
            "sourceSummary": "short description of which official source(s) you used, or empty string if found=false",
            "requirementsText": "a structured plain-text summary of the actual requirements, in English, ready to be used as a compliance reference. Empty string if found=false."
          }

          Set "found": false and leave the text fields empty if you cannot locate genuine official regulatory content for this specific country — do NOT fabricate or guess generic requirements.
          Return ONLY the raw JSON object, no markdown code fences, no commentary before or after it.
          `;

          // Note: grounding tools (google_search) are not reliably combinable with forced
          // JSON response mode on all Gemini versions, so we ask for raw JSON in the prompt
          // and parse defensively instead (same pattern as referenceLabelWorker.js).
          const searchResult = await callGeminiWithRetry(searchModel, {
            contents: [{ role: "user", parts: [{ text: searchPrompt }] }]
          });

          const rawSearchText = searchResult.response.text();
          const cleanSearchJsonStr = rawSearchText.replace(/```json/g, "").replace(/```/g, "").trim();
          const searchJson = JSON.parse(cleanSearchJsonStr);
          if (searchJson.found && searchJson.requirementsText?.trim()) {
            edaRequirementsText = searchJson.requirementsText.trim();
            console.log(`[Label Generator] Task ${taskId}: Found requirements via web search for ${country}.`);

            // Cache it so we never need to search for this country again.
            await prisma.edaRequirement.create({
              data: {
                country,
                extractedText: edaRequirementsText,
                extractedData: {
                  source: "ai_web_search",
                  sourceSummary: searchJson.sourceSummary || null,
                  searchedAt: new Date().toISOString()
                }
              }
            });
          } else {
            console.log(`[Label Generator] Task ${taskId}: Web search found no reliable official requirements for ${country}.`);
          }
        } catch (err) {
          console.error(`[Label Generator] Task ${taskId}: Web search for EDA requirements failed.`, err);
        }
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

      let confirmedFactsBlock = "";
      if (aimOfUseHint || targetSpeciesHint || directionOfUseHint) {
        confirmedFactsBlock = `
      === USER-CONFIRMED FACTS (ABSOLUTE GROUND TRUTH — HIGHEST PRIORITY) ===
      The user is the manufacturer/expert for this exact product and has confirmed the following facts directly. These OVERRIDE any reference label, EDA requirement, or your own general knowledge. Do NOT contradict, water down, or add unrelated species/claims/dosages on top of them — just translate, clean the wording, and slot them into the correct schema fields.
      ${aimOfUseHint ? `- Confirmed Aim of Use / Indication: ${aimOfUseHint}\n` : ""}${targetSpeciesHint ? `- Confirmed Target Animal Species: ${targetSpeciesHint}\n` : ""}${directionOfUseHint ? `- Confirmed Direction of Use / Dosage: ${directionOfUseHint}\n` : ""}
      `;
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
      ${confirmedFactsBlock}
      ${sourcingInstruction}

      REGULATORY CONSTRAINT — NO MEDICAL/THERAPEUTIC CLAIMS in 'aimOfUse' (per Saudi Food & Drug Authority feed labeling rules, applies regardless of country):
      Feed product labels (non-medicated) MUST NOT claim to treat, cure, or medically manage disease. This applies even if the confirmed facts above or a reference use such wording — rephrase into compliant language while KEEPING the same underlying meaning/target condition, do not drop the information.
      - FORBIDDEN verbs/phrasing (reject these even if present in input): "treats", "cures", "يعالج", claims like treating diarrhea, cough, parasites, infections, digestive diseases, or "boosts/raises the immune system" (يرفع من الجهاز المناعي).
      - FORBIDDEN vague filler: "for animal comfort", "for maximum feed benefit" or similarly meaningless phrasing.
      - ACCEPTED style instead: supportive/nutritional framing such as "a source of vitamins and minerals", "a source of vitamin C", "supports/improves immune function", "supports/improves digestion", "improves fertility", "feed for fattening [species]", "urinary acidifier to help prevent urinary calculi (urolithiasis)" — i.e. preventive/supportive framing is fine, therapeutic/curative framing is not.

      ANALYSIS SECTION RULES:
      Include an "analysis" section stating the nutrient/active-substance breakdown on a "per 1 kg" or "per 1 liter" basis (pick whichever matches the product's net weight/volume unit). This section is ENGLISH ONLY (do not translate it) per official feed-labeling rules.
      - For a feed material or compound feed (multi-nutrient product): include the standard applicable panel — Energy, Moisture, Protein, Fiber, Fat, Starch, and any relevant vitamins/minerals — using ONLY the items relevant to this product's actual composition (do not invent nutrients unrelated to the formulation).
      - For a feed additive or premix (single/few active substances): list the active substance(s) and their concentration/percentage as given in the Input Formulation, not a full nutrient panel.
      - If a value is not derivable from the Input Formulation or references, use "x" as a placeholder for the numeric part (matching official template convention), do not fabricate a specific number.

      USAGE DECLARATION RULES:
      Pick exactly ONE bilingual phrase for 'usageDeclaration' from these official options, choosing the one that matches the product:
      - Default: en: "For Animal Consumption" / target equivalent, PLUS a second line en: "For Animal Feed Plant" / target equivalent (both together, as two lines) — use this for most products.
      - If the product is a BULK compound feed clearly tied to one or more specific livestock project types (from the Input Formulation/target species), use instead ONE of: "For Animal Consumption - used in cattle projects", "For Animal Consumption - used in poultry projects", or "For Animal Consumption - used in cattle and poultry projects" (translated equivalent) — pick whichever matches the confirmed target species.

      CRITICAL FORMATTING REQUIREMENTS ("شغل فاخر"):
      You MUST output the result as a strict, valid JSON object. Do NOT write any conversational text or markdown code blocks around the JSON.
      The JSON object MUST follow this exact premium schema. Translate accurately into the target language. Use robust, scientific terminology:

      {
        "productName": { "en": "Name in English", "target": "Name in Target Language" },
        "feedClassification": { "en": "e.g. Feed Additive (Non-Medicated)", "target": "e.g. إضافة علفية غير دوائية" },
        "ingredients": [
          { "en": "Ingredient in English", "target": "Ingredient in Target Language", "amount": "e.g. 1000 gm" }
        ],
        "analysis": {
          "basis": "e.g. per 1 kg",
          "items": [
            { "name": "e.g. Protein", "value": "e.g. x %" }
          ]
        },
        "aimOfUse": { "en": "Indications in English", "target": "Indications in Target Language" },
        "targetAnimalSpecies": { "en": "e.g. Cow - Buffalo - Sheep", "target": "الأبقار - الجاموس - الأغنام" },
        "directionOfUse": { "en": "Dosage instructions in English", "target": "Dosage instructions in Target Language" },
        "storage": { "en": "Storage conditions in English", "target": "Storage conditions in Target Language" },
        "netWeight": { "en": "e.g. 25 kg", "target": "e.g. 25 كجم" },
        "usageDeclaration": [
          { "en": "e.g. For Animal Consumption", "target": "e.g. للاستهلاك الحيواني" }
        ],
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

      // Step 3.5: Compliance Check against the stored regulatory authority requirements
      // Only runs when we actually have authority requirements on file for this country —
      // otherwise there is nothing authoritative to check against.
      if (edaRequirementsText) {
        console.log(`[Label Generator] Task ${taskId}: Validating against ${country} authority requirements...`);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 90, message: `Validating against ${country} regulatory requirements...` });

        const complianceCheckPrompt = `
        You are a regulatory compliance auditor for animal feed/veterinary product labels.
        Below is a DRAFT label (as JSON) and the OFFICIAL REGULATORY AUTHORITY REQUIREMENTS for ${country} that this label must comply with.

        === OFFICIAL REGULATORY AUTHORITY REQUIREMENTS (${country}) ===
        ${edaRequirementsText}

        === DRAFT LABEL JSON ===
        ${JSON.stringify(generatedJson, null, 2)}

        TASK:
        Check the draft against the official requirements above for compliance issues, e.g.:
        - Missing or wrongly-worded mandatory fields/sections required by the authority.
        - Terminology, classification, or category wording that doesn't match the authority's controlled vocabulary (e.g. product/feed classification, target species naming).
        - Any claim, phrasing, or field that the authority's requirements explicitly disallow.
        - Formatting/structure the authority mandates (e.g. bilingual vs a section that must stay in one language only) that the draft violates.

        If the draft already complies, return it UNCHANGED. If it has issues, fix ONLY what's needed to become compliant — do not rewrite content that isn't a compliance problem, and do not remove or invent facts beyond what compliance requires.

        Return ONLY a raw JSON object with the exact same schema as the DRAFT LABEL JSON above (same keys: productName, feedClassification, ingredients, analysis, aimOfUse, targetAnimalSpecies, directionOfUse, storage, netWeight, usageDeclaration, mandatoryFields). Do not add extra keys, do not wrap in markdown.
        `;

        try {
          const complianceResult = await callGeminiWithRetry(model, {
            contents: [{ role: "user", parts: [{ text: complianceCheckPrompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          });
          const correctedJson = JSON.parse(complianceResult.response.text());
          generatedJson = correctedJson;
          console.log(`[Label Generator] Task ${taskId}: Compliance check complete.`);
        } catch (err) {
          console.error(`[Label Generator] Task ${taskId}: Compliance check failed, keeping original draft.`, err);
        }
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
