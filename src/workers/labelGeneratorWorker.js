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
      For 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse', and 'storage' where no confirmed hint was given above, actively determine your single best, complete answer using standard, well-established veterinary/feed-industry knowledge for THIS specific active ingredient — do not leave it vague, generic, or partial. Be scientifically accurate rather than padding with unrelated species this ingredient isn't actually used for (e.g. do not add poultry to a product whose established use is ruminants-only) — but DO include every species this ingredient IS established for, even if that's a long list. Add "targetAnimalSpecies" (and any other field you inferred this way) to "estimatedFields".
      `;
      } else {
        sourcingInstruction = `
      SOURCE OF TRUTH — NO REFERENCES AVAILABLE:
      No approved reference labels exist yet for this ingredient. Where no confirmed hint was given above, actively determine your single best, complete answer for 'aimOfUse', 'targetAnimalSpecies', 'directionOfUse', and 'storage' using standard, well-established veterinary/feed-industry knowledge for THIS specific active ingredient — do not leave it vague or partial. Be scientifically accurate: include every species this ingredient IS established for, but don't pad with species/claims it genuinely isn't used for. Add "targetAnimalSpecies" (and any other field you inferred this way) to "estimatedFields".
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

      INGREDIENTS AMOUNT RULE (do not leave this blank, ever):
      Every item in "ingredients" MUST have a non-empty "amount" that mirrors the quantity/unit stated in the Input Formulation VERBATIM (e.g. Input says "Ammonium Chloride 1000 gm" → amount is "1000 gm"). Never invent a percentage conversion here and never leave it blank — if truly no quantity was stated for an ingredient, write "q.s." rather than leaving it empty.

      ANALYSIS SECTION RULES:
      Include an "analysis" section stating the nutrient/active-substance breakdown on a "per 1 kg" or "per 1 liter" basis (pick whichever matches the product's net weight/volume unit). This section is ENGLISH ONLY (do not translate it) per official feed-labeling rules.
      - For a feed material or compound feed (multi-nutrient product): include the standard applicable panel — Energy, Moisture, Protein, Fiber, Fat, Starch, and any relevant vitamins/minerals — using ONLY the items relevant to this product's actual composition (do not invent nutrients unrelated to the formulation).
      - For a feed additive or premix (single/few active substances): the active substance value here MUST be numerically CONSISTENT with the "amount" you wrote in "ingredients" for that same substance (same underlying fact, e.g. both say "1000 gm" — or if the Input Formulation's stated quantity already IS the per-kg content and no separate carrier/filler is mentioned, that means it's ~100% of the base, so analysis may state "1000 gm" or "100%" but must not invent an unrelated percentage like "4%" out of nowhere).
      - If a numeric value is not directly derivable from the Input Formulation, confirmed facts, or a matched reference, do NOT leave a bare "x" placeholder — instead give your single best scientifically-grounded ESTIMATE for that specific active ingredient/product type, based on standard veterinary/feed-industry norms (e.g. a typical Energy/Moisture value for that class of feed material). Every field must end up with a real, usable number. Add the field's name to "estimatedFields" (see schema below) whenever you did this, so the user knows to double-check it.

      NUMERIC ESTIMATION RULE (applies to directionOfUse dosage numbers and any other numeric value not covered by a more specific rule above):
      Never output a literal "x" as a stand-in number. If a confirmed hint, matched reference, or the Input Formulation gives you the real number, use it exactly. Otherwise, provide your best scientifically-grounded estimate using standard veterinary/feed-industry dosing norms for that specific active ingredient and species — reason from known pharmacology/typical inclusion rates, not a random guess — and add that field's name to "estimatedFields".

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
            { "name": "e.g. Protein", "value": "e.g. 12 %" }
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
        },
        "estimatedFields": ["e.g. directionOfUse", "e.g. analysis"]
      }

      "estimatedFields" MUST list the top-level field names (from the schema above) whose content is your own scientific estimate rather than something confirmed by the user, the input formulation, or a matched reference. Leave it an empty array [] if every field came from confirmed facts/input/reference.
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

        Return ONLY a raw JSON object with the exact same schema as the DRAFT LABEL JSON above (same keys: productName, feedClassification, ingredients, analysis, aimOfUse, targetAnimalSpecies, directionOfUse, storage, netWeight, usageDeclaration, mandatoryFields, estimatedFields). Do not add extra keys, do not wrap in markdown.
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

      // Step 3.6: Content Accuracy Self-Review — always runs (independent of country/authority
      // requirements), re-checking the draft against the facts we actually gave the model:
      // the user's confirmed hints, the grounding reference (if any), and internal consistency.
      console.log(`[Label Generator] Task ${taskId}: Running content accuracy self-review...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 95, message: "Double-checking accuracy against the source facts..." });

      const groundingRecap = matchTier === "ingredient_match"
        ? `A reference label for this exact active ingredient was used for grounding:\n${referenceLabels.slice(0, 3).map(r => `--- ${r.name} ---\n${r.extractedData ? JSON.stringify(r.extractedData) : (r.fullText || "").substring(0, 800)}`).join("\n")}`
        : "No exact-ingredient reference was available; the draft relied on the confirmed hints below plus conservative general knowledge.";

      const selfReviewPrompt = `
      You are a strict fact-checking editor reviewing an AI-generated animal feed/veterinary label before it ships to the customer.

      === ORIGINAL INPUT FORMULATION ===
      ${formulationText}

      === USER-CONFIRMED FACTS (must be reflected exactly, not contradicted) ===
      ${aimOfUseHint ? `Aim of Use: ${aimOfUseHint}\n` : ""}${targetSpeciesHint ? `Target Animal Species: ${targetSpeciesHint}\n` : ""}${directionOfUseHint ? `Direction of Use: ${directionOfUseHint}\n` : ""}${(!aimOfUseHint && !targetSpeciesHint && !directionOfUseHint) ? "(none provided)" : ""}

      === GROUNDING CONTEXT ===
      ${groundingRecap}

      === DRAFT LABEL JSON TO REVIEW ===
      ${JSON.stringify(generatedJson, null, 2)}

      CHECK FOR THESE SPECIFIC ISSUES ONLY — fix any you find, do not rewrite anything else:
      1. "ingredients[].amount" must never be empty and must match the quantity/unit stated in the Input Formulation.
      2. "analysis" values for the same substance must be numerically consistent with "ingredients[].amount" — no unexplained/invented numbers.
      3. If a confirmed fact was provided above (Aim of Use, Target Species, or Direction of Use), the corresponding field in the draft MUST match it faithfully (translated only) — flag and fix any contradiction or drift.
      4. If grounding context above lists a reference, the draft's species/dosage/indication must not contain anything absent from that reference (no added species, no added claims).
      5. No therapeutic/medical claims ("treats", "cures", "يعالج", disease-treatment wording) anywhere in aimOfUse.
      6. Every "en"/"target" pair must actually be translations of each other, not different content.
      7. No field may contain a bare "x" placeholder — any such field must be filled with a real, scientifically-grounded estimated number, and its field name added to "estimatedFields" if it isn't already there.

      If the draft already satisfies all 7 checks, return it completely UNCHANGED. Otherwise return the corrected JSON with ONLY the necessary fixes applied.

      Return ONLY a raw JSON object with the exact same schema as the DRAFT LABEL JSON above (same keys: productName, feedClassification, ingredients, analysis, aimOfUse, targetAnimalSpecies, directionOfUse, storage, netWeight, usageDeclaration, mandatoryFields, estimatedFields). Do not add extra keys, do not wrap in markdown.
      `;

      try {
        const selfReviewResult = await callGeminiWithRetry(model, {
          contents: [{ role: "user", parts: [{ text: selfReviewPrompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        });
        generatedJson = JSON.parse(selfReviewResult.response.text());
        console.log(`[Label Generator] Task ${taskId}: Self-review complete.`);
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: Self-review failed, keeping prior draft.`, err);
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
