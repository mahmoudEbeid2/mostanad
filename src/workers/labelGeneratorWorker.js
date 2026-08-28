import { Worker } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import { GoogleGenAI } from "@google/genai";
import io from "socket.io-client";
import { MODELS } from "../services/ai/modelRegistry.js";
import * as versionService from "../services/label/versioning/versionService.js";

// Best-effort per-field provenance (Invariant #3 / §14.4). This is a Phase 1 stopgap:
// it tags each top-level field with the tier/source this worker's own control flow
// already knows (matchTier, targetAnimalsSource, user hints, estimatedFields) — it is
// NOT the full Tier 1-6 product-resolution ladder from §8.2, which needs Phase 4's
// productProfile (reading the Product row) to exist. Tier 1 ("confirmed" via Product
// row) never appears here for that reason; re-derive this once Phase 4 lands.
function buildFieldProvenance({ generatedJson, matchTier, targetAnimalsSource, matchedIngredientRefs, aimOfUseHint, targetSpeciesHint, directionOfUseHint, modelId }) {
  const at = new Date().toISOString();
  const estimated = new Set(generatedJson.estimatedFields || []);
  const referenceSourceRef = { kind: "reference_label", ids: matchedIngredientRefs.map((r) => r.id) };
  const provenance = {};

  const set = (path, tier, source, sourceRef = null) => {
    provenance[path] = { tier, provenance: source, sourceRef, modelId, at };
  };

  set(
    "targetAnimalSpecies",
    targetAnimalsSource === "confirmed" ? 2 : targetAnimalsSource === "reference" ? 4 : 6,
    targetAnimalsSource,
    targetAnimalsSource === "reference" ? referenceSourceRef
      : targetAnimalsSource === "confirmed" ? { kind: "user_hint", field: "targetSpeciesHint" }
      : null
  );

  const setReferenceOrEstimated = (path, hint) => {
    if (hint && hint.trim()) {
      set(path, 2, "confirmed", { kind: "user_hint", field: `${path}Hint` });
    } else if (matchTier === "ingredient_match") {
      set(path, 4, "reference", referenceSourceRef);
    } else {
      set(path, estimated.has(path) ? 5 : 6, "inferred");
    }
  };
  setReferenceOrEstimated("aimOfUse", aimOfUseHint);
  setReferenceOrEstimated("directionOfUse", directionOfUseHint);
  setReferenceOrEstimated("storage", null);

  // Everything else the worker produces comes from parsing formulationText (free text
  // input) plus general model knowledge for structure/wording — Tier 3 ("extracted"),
  // downgraded to Tier 5 ("inferred") when the model itself flagged it as estimated.
  ["productName", "feedClassification", "ingredients", "analysis", "netWeight", "usageDeclaration"].forEach((path) => {
    set(path, estimated.has(path) ? 5 : 3, estimated.has(path) ? "inferred" : "extracted");
  });

  return provenance;
}

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "http://localhost:3000";
const socket = io(BACKEND_WS_URL);

socket.on("connect", () => {
  console.log(`[Label Generator Worker] Connected to socket server: ${BACKEND_WS_URL}`);
});

// modelSpec: an entry from modelRegistry.js ({ id, thinkingBudget, temperature }).
// requestParams: { contents, config? } — config is merged with the model's own
// temperature/thinkingConfig so callers can still add e.g. responseMimeType or tools.
async function callGeminiWithRetry(modelSpec, requestParams, retries = 5, delay = 5000) {
  const config = {
    temperature: modelSpec.temperature,
    thinkingConfig: { thinkingBudget: modelSpec.thinkingBudget },
    ...(requestParams.config || {}),
  };
  while (retries > 0) {
    try {
      return await ai.models.generateContent({ model: modelSpec.id, contents: requestParams.contents, config });
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
    const { taskId, companyId, createdByUserId, formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint } = job.data;

    console.log(`[Label Generator] Started task: ${taskId} for Country: ${country}, Language: ${language}`);

    try {
      // Notify starting
      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: { status: "processing" }
      });
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 10, message: "Extracting active ingredients..." });

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
        const extractResult = await callGeminiWithRetry(MODELS.EXTRACT, { contents: extractPrompt });
        const extractText = extractResult.text;
        activeIngredientsList = extractText.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        console.log(`[Label Generator] Task ${taskId}: Found ingredients:`, activeIngredientsList);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 30, message: `Found ingredients: ${activeIngredientsList.join(", ")}` });
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: Extraction failed.`, err);
        socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 30, message: `Extraction failed, proceeding with generic search.` });
      }

      // Step 2: Search Reference Labels — Active-Ingredient-First Matching
      //
      // The ACTIVE INGREDIENT(S) are the primary/only matching key for deciding which
      // reference to trust — never product name, brand, category, or wording similarity.
      // Every reference is scored by how well its active ingredients overlap with this
      // product's; an exact combination match outranks a partial overlap, which outranks
      // a country-only or generic (style-guide-only) fallback.
      console.log(`[Label Generator] Task ${taskId}: Searching reference labels...`);
      socket.emit("job_status_update", { jobId: taskId, status: "processing", progress: 50, message: "Searching database for similar approved labels..." });

      const normalizeIngredientName = (s) =>
        (s || "").toString().toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

      const productIngredientsNorm = [...new Set(activeIngredientsList.map(normalizeIngredientName).filter(Boolean))];

      // Prefer the structured "active_ingredients" field (populated by referenceLabelWorker for
      // newer references). Falls back to the older free-text ingredients/composition sections
      // for references processed before that field existed.
      const getReferenceIngredients = (ref) => {
        const structured = ref.extractedData?.active_ingredients;
        if (Array.isArray(structured) && structured.length > 0) {
          const names = structured
            .map((i) => normalizeIngredientName(typeof i === "string" ? i : i?.name))
            .filter(Boolean);
          if (names.length > 0) return { names, structured: true };
        }
        const sections = ref.extractedData?.sections || {};
        const raw = []
          .concat(Array.isArray(sections.ingredients) ? sections.ingredients : (sections.ingredients ? [sections.ingredients] : []))
          .concat(Array.isArray(sections.composition) ? sections.composition : (sections.composition ? [sections.composition] : []));
        return { names: raw.map(normalizeIngredientName).filter(Boolean), structured: false };
      };

      const getReferenceTargetSpecies = (ref) => {
        const structured = ref.extractedData?.target_animal_species;
        if (Array.isArray(structured)) return structured.map((s) => (s || "").toString().trim()).filter(Boolean);
        return [];
      };

      // Score: 3 = exact active-ingredient combination match (structured data only),
      //        2 = shares at least one active ingredient, 0 = no overlap.
      const scoreIngredientMatch = (ref) => {
        if (productIngredientsNorm.length === 0) return { score: 0, overlap: 0 };
        const { names: refNames, structured } = getReferenceIngredients(ref);
        if (refNames.length === 0) return { score: 0, overlap: 0 };

        const overlap = productIngredientsNorm.filter((pi) =>
          refNames.some((ri) => ri === pi || ri.includes(pi) || pi.includes(ri))
        ).length;
        if (overlap === 0) return { score: 0, overlap: 0 };

        const isExactCombo = structured && refNames.length === productIngredientsNorm.length && overlap === productIngredientsNorm.length;
        return { score: isExactCombo ? 3 : 2, overlap };
      };

      let referenceLabels = [];
      let matchTier = "none"; // "ingredient_match" | "country_match" | "generic" | "none"
      let matchedIngredientRefs = []; // the reference(s) that matched on active ingredient(s) — ground truth for target animals

      try {
        // Tenant-scoped: a company's job must only ever see its own references plus
        // global ones (companyId: null) — never another tenant's. Also caps the load
        // instead of pulling the entire table into worker memory on every job.
        const allRefs = await prisma.referenceLabel.findMany({
          where: { OR: [{ companyId }, { companyId: null }] },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });

        const targetCountry = (country || "").toLowerCase();

        const scored = allRefs
          .filter((ref) => ref.extractedData || ref.fullText)
          .map((ref) => ({ ref, ...scoreIngredientMatch(ref) }));

        const ingredientMatches = scored.filter((s) => s.score > 0);

        if (ingredientMatches.length > 0) {
          const bestScore = Math.max(...ingredientMatches.map((s) => s.score));
          const bestTier = ingredientMatches.filter((s) => s.score === bestScore);

          // Within the best (strongest) tier, order by same-country first (helps regulatory/
          // style fit), then by overlap size, then recency — but EVERY reference in the best
          // tier still counts as ingredient-matched ground truth (needed to reconcile multiple
          // matching references instead of randomly picking one).
          bestTier.sort((a, b) => {
            const aCountry = (a.ref.country || "").toLowerCase() === targetCountry ? 1 : 0;
            const bCountry = (b.ref.country || "").toLowerCase() === targetCountry ? 1 : 0;
            if (bCountry !== aCountry) return bCountry - aCountry;
            if (b.overlap !== a.overlap) return b.overlap - a.overlap;
            return new Date(b.ref.createdAt) - new Date(a.ref.createdAt);
          });

          matchedIngredientRefs = bestTier.slice(0, 3).map((s) => s.ref);
          referenceLabels = matchedIngredientRefs;
          matchTier = "ingredient_match";
          console.log(`[Label Generator] Found ${matchedIngredientRefs.length} reference(s) matching active ingredient(s) (score ${bestScore}/3): ${matchedIngredientRefs.map(r => r.name).join(", ")}`);
        } else {
          const sameCountry = scored.filter((s) => (s.ref.country || "").toLowerCase() === targetCountry);
          if (sameCountry.length > 0) {
            console.log(`[Label Generator] No active-ingredient match. Found ${sameCountry.length} same-country reference(s) — style guide only.`);
            referenceLabels = [sameCountry[0].ref];
            matchTier = "country_match";
          } else if (allRefs.length > 0) {
            console.log(`[Label Generator] Falling back to generic global references.`);
            referenceLabels = [allRefs[0]];
            matchTier = "generic";
          }
        }
      } catch (err) {
        console.error(`[Label Generator] Task ${taskId}: DB search error`, err);
      }

      // Deterministic Target Animal reconciliation, computed in code (not left to the AI to
      // self-report) so "source: reference" in the response is always trustworthy. Unions the
      // target species across every reference in the best-matching tier — if they agree this is
      // just that one set; if they differ, every species backed by a matching reference is kept
      // rather than silently dropping one (see TEST 6 in the target-animals spec).
      let deterministicTargetAnimals = [];
      if (matchTier === "ingredient_match") {
        const speciesSets = matchedIngredientRefs
          .map((ref) => getReferenceTargetSpecies(ref))
          .filter((sp) => sp.length > 0);
        if (speciesSets.length > 0) {
          const seen = new Map();
          speciesSets.flat().forEach((sp) => {
            const key = sp.toLowerCase().trim();
            if (!seen.has(key)) seen.set(key, sp.trim());
          });
          deterministicTargetAnimals = [...seen.values()];
        }
      }

      const targetSpeciesConfirmedByUser = !!(targetSpeciesHint && targetSpeciesHint.trim());
      const targetAnimalsSource = targetSpeciesConfirmedByUser
        ? "confirmed"
        : (matchTier === "ingredient_match" ? "reference" : "inferred");

      // Step 2.5: Search EDA Requirements (stored in DB first, then fall back to a live web search)
      let edaRequirementsText = "";
      try {
        // §7.1's resolution order — prefer an approved (human-reviewed) document for
        // this country over anything still pending_review (e.g. a cached web search
        // from Step 2.6 below), so an unofficial/unreviewed source never silently
        // outranks one a human actually approved.
        const edaReqs = await prisma.regulatoryDocument.findMany({
          where: { country: { equals: country, mode: 'insensitive' } },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], // 'approved' < 'pending_review' alphabetically
          take: 1
        });
        if (edaReqs.length > 0 && edaReqs[0].extractedText) {
          edaRequirementsText = edaReqs[0].extractedText;
          console.log(`[Label Generator] Found stored regulatory document for ${country} (status: ${edaReqs[0].status})`);
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

          // Note: grounding tools (googleSearch) are not reliably combinable with forced
          // JSON response mode on all Gemini versions, so we ask for raw JSON in the prompt
          // and parse defensively instead (same pattern as referenceLabelWorker.js).
          const searchResult = await callGeminiWithRetry(MODELS.WEB_SEARCH, {
            contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
            config: { tools: [{ googleSearch: {} }] },
          });

          const rawSearchText = searchResult.text;
          const cleanSearchJsonStr = rawSearchText.replace(/```json/g, "").replace(/```/g, "").trim();
          const searchJson = JSON.parse(cleanSearchJsonStr);
          if (searchJson.found && searchJson.requirementsText?.trim()) {
            edaRequirementsText = searchJson.requirementsText.trim();
            console.log(`[Label Generator] Task ${taskId}: Found requirements via web search for ${country}.`);

            // Cache it so we never need to search for this country again — but NEVER
            // as authoritative: no sourceUrl survived a generic Google Search grounding
            // call, so this is explicitly unofficial and pending_review (§7.1/§7.2 — G4's
            // fix). It's still usable as advisory context for THIS generation (below),
            // but Step 2.5 above will always prefer a real approved document over this
            // the next time this country comes up.
            await prisma.regulatoryDocument.create({
              data: {
                country,
                sourceType: "ai_web_search",
                sourceIsOfficial: false,
                status: "pending_review",
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
      SOURCE OF TRUTH — STRICT GROUNDED MODE (reference(s) matching this exact active ingredient are provided):
      You MUST strictly copy the factual data from the Reference Label(s) for 'aimOfUse', 'directionOfUse', and 'storage' (Target Animal Species is governed by its own dedicated rule below — follow that one for it, not this paragraph).
      - DO NOT add extra indications or uses (e.g., do NOT add respiratory support if the reference only mentions urinary).
      - PRESERVE the exact dosage numbers and percentages from the reference.
      - Your job is merely to format, translate, and structure the reference data to match the requested premium JSON schema.
      `;
      } else if (matchTier === "country_match" || matchTier === "generic") {
        sourcingInstruction = `
      SOURCE OF TRUTH — NO DIRECT INGREDIENT MATCH (the references above are NOT for this same active ingredient; they only show formatting/tone/structure conventions):
      Do NOT copy factual content (dosages, indications) from these references — they are for a different active ingredient. Use them ONLY as a style/format/phrasing guide.
      For 'aimOfUse' and 'directionOfUse' and 'storage' where no confirmed hint was given above, actively determine your single best, complete answer using standard, well-established veterinary/feed-industry knowledge for THIS specific active ingredient — do not leave it vague, generic, or partial. Add any such field to "estimatedFields".
      `;
      } else {
        sourcingInstruction = `
      SOURCE OF TRUTH — NO REFERENCES AVAILABLE:
      No approved reference labels exist yet for this ingredient. Where no confirmed hint was given above, actively determine your single best, complete answer for 'aimOfUse', 'directionOfUse', and 'storage' using standard, well-established veterinary/feed-industry knowledge for THIS specific active ingredient — do not leave it vague or partial. Add any such field to "estimatedFields".
      `;
      }

      // ── TARGET ANIMAL SPECIES — dedicated decision flow ───────────────────────────────────
      // The active ingredient(s) are the ONLY signal used to pick a reference's target animals.
      // Product name, brand, category, indication wording, or "this looks similar" reasoning
      // must NEVER be used to borrow target animals from an unrelated reference.
      let targetAnimalsInstruction;
      if (targetSpeciesConfirmedByUser) {
        targetAnimalsInstruction = `
      TARGET ANIMAL SPECIES — USER-CONFIRMED (highest priority, do not override):
      The user has directly confirmed the target species: "${targetSpeciesHint}". Use exactly this (translated) for 'targetAnimalSpecies'. Do not add species from any reference or your own knowledge on top of this. Do NOT add "targetAnimalSpecies" to "estimatedFields".
      `;
      } else if (matchTier === "ingredient_match" && deterministicTargetAnimals.length > 0) {
        targetAnimalsInstruction = `
      TARGET ANIMAL SPECIES — REFERENCE MATCH (matched strictly by shared active ingredient(s), NOT by product name):
      Reference(s) sharing this product's exact active ingredient(s): ${matchedIngredientRefs.map(r => r.name).join(", ")}.
      Their combined confirmed target animal species are: ${deterministicTargetAnimals.join(", ")}.
      You MUST use exactly this set of species (translated) for 'targetAnimalSpecies' — do not add, drop, or substitute any species, and do not add a species just because it seems plausible or related. This came from a matching reference, so do NOT add "targetAnimalSpecies" to "estimatedFields".
      `;
      } else if (matchTier === "ingredient_match") {
        targetAnimalsInstruction = `
      TARGET ANIMAL SPECIES — REFERENCE MATCH (matched strictly by shared active ingredient(s), NOT by product name):
      Reference(s) sharing this product's exact active ingredient(s): ${matchedIngredientRefs.map(r => r.name).join(", ")}.
      Read ONLY these reference(s)' full text/structured data above and extract the target animal species explicitly stated there for 'targetAnimalSpecies'. Do NOT invent species not stated in these specific references, and do NOT pull species from any other reference in this prompt (any other reference here does not share the active ingredient, even if its product name or category looks similar). Do NOT add "targetAnimalSpecies" to "estimatedFields".
      `;
      } else {
        targetAnimalsInstruction = `
      TARGET ANIMAL SPECIES — NO MATCHING REFERENCE (fallback: AI inference):
      No uploaded reference shares this product's active ingredient(s) — matching is by active ingredient ONLY, and any reference shown above (if any) is for a DIFFERENT active ingredient, so it must NOT be used as a source for target species no matter how similar its product name, category, or indication looks.
      You MUST still provide a complete, non-empty 'targetAnimalSpecies' — infer your single best, scientifically-grounded answer using everything available: the active ingredient(s), formulation, dosage, indication, administration route, and any species information elsewhere in the input. Be accurate: include every species this ingredient is established for, but do not pad with unrelated species. Add "targetAnimalSpecies" to "estimatedFields" since this is an inference, not a confirmed fact.
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
      ${targetAnimalsInstruction}

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

      const genResult = await callGeminiWithRetry(MODELS.LABEL_GENERATE, {
        contents: [{ role: "user", parts: [{ text: generationPrompt }] }],
        config: { responseMimeType: "application/json" },
      });
      let generatedJson = {};
      try {
        generatedJson = JSON.parse(genResult.text);
      } catch (err) {
        console.error("Failed to parse JSON from AI", err);
        throw new Error("AI returned invalid data format.");
      }

      // Steps 3.5/3.6 (compliance re-check + "self-review" second-generation passes) were
      // removed in Phase 2 (G3): a model re-generating its own output and calling that
      // "validation" is Invariant #1's exact violation (validation writing content, no
      // pass/fail ever produced or stored, both wrapped in swallowing try/catch). Real
      // validation is POST /labels/:id/validate -> validationEngine (deterministic,
      // §4.2). This worker's generation prompt still produces the pre-Phase-4 ad-hoc
      // shape (productName/ingredients/etc., not labelSchema's), so running it through
      // validationEngine today would just be schema-layer noise — that conversion is
      // Phase 4's "labelGenerator مقيّد" (schema-constrained generation), not this one.

      // Attach deterministic Target Animals provenance — computed here in code from the actual
      // matching logic above, not self-reported by the AI, so the frontend can reliably tell
      // apart reference-derived vs AI-inferred vs user-confirmed target animals without any
      // risk of the model fabricating a "source: reference" claim.
      generatedJson.targetAnimalsSource = targetAnimalsSource; // "confirmed" | "reference" | "inferred"
      generatedJson.matchedReferenceLabels = matchTier === "ingredient_match"
        ? matchedIngredientRefs.map((r) => ({ id: r.id, name: r.name }))
        : [];

      // Step 4: Persist — GeneratedLabel + LabelVersion v1 + per-field provenance (Phase 1, §5.1/§14.4)
      const labelProvenance = buildFieldProvenance({
        generatedJson,
        matchTier,
        targetAnimalsSource,
        matchedIngredientRefs,
        aimOfUseHint,
        targetSpeciesHint,
        directionOfUseHint,
        modelId: MODELS.LABEL_GENERATE.id,
      });

      const label = await versionService.createInitial({
        companyId,
        createdByUserId,
        inputPayload: { formulationText, country, language, aimOfUseHint, targetSpeciesHint, directionOfUseHint },
        labelData: generatedJson,
        labelProvenance,
        // Matches the literal §6.3/§5.1 will assert once Phase 2's labelSchema.js exists, so
        // this never has to be migrated forward. The JSON this worker actually produces does
        // NOT yet conform to that schema (no LocalizedText, no withdrawalPeriod, etc.) — that's
        // expected: Phase 2's schemaValidator is exactly what will report that gap as real FAILs
        // on these labels until Phase 4 rewrites generation to satisfy it, not silently coerced.
        schemaVersion: "vet-label@2.0.0",
        country,
        language,
        referenceLabelIds: matchTier === "ingredient_match" ? matchedIngredientRefs.map((r) => r.id) : [],
        matchTier,
        generationMeta: {
          modelId: MODELS.LABEL_GENERATE.id,
          temperature: MODELS.LABEL_GENERATE.temperature,
          thinkingBudget: MODELS.LABEL_GENERATE.thinkingBudget,
        },
      });

      const result = { taskId, labelId: label.id, label: generatedJson };

      await prisma.backgroundTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          result,
        }
      });

      socket.emit("job_status_update", { jobId: taskId, status: "completed", progress: 100, result, message: "Label generated successfully!" });
      console.log(`[Label Generator] Task ${taskId} completed successfully. Label ID: ${label.id}`);

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
