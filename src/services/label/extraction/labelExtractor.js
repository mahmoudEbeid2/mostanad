import fs from "fs";
import path from "path";
import AppError from "../../../utils/appError.js";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { matchProduct } from "../retrieval/productMatcher.js";

// labelExtractor — EXTRACTION ONLY (§4.2). Was labelService.verifyProductLabel's
// Steps 1-2. No compliance judgement is made here — that violates Invariant #1
// ("Generation writes content, never a verdict") just as much on the upload path
// as it did on labelGeneratorWorker's deleted Steps 3.5/3.6. The single AI call
// below extracts whatever the label visibly states into labelSchema's shape;
// validationEngine (deterministic) decides what's missing/wrong.
//
// KNOWN SIMPLIFICATION: every extracted text field is wrapped as a single-language
// LocalizedText ({ translations: { en: text }, primary: "en" }) regardless of what
// language the source label is actually printed in. A real OCR/extraction pass
// would detect and tag the source language(s); this only had one AI call's budget
// in Phase 2 and defers proper language handling.

function toLocalizedText(text) {
  if (!text || typeof text !== "string" || !text.trim()) return null;
  return { translations: { en: text.trim() }, primary: "en" };
}

function mapToLabelData(extracted, country) {
  const ingredients = Array.isArray(extracted.activeIngredients) ? extracted.activeIngredients : [];
  return {
    schemaVersion: "vet-label@2.0.0",
    productType: extracted.productType || "feed_additive",
    productName: toLocalizedText(extracted.productName) || { translations: { en: "Unknown" }, primary: "en" },
    pharmaceuticalForm: toLocalizedText(extracted.pharmaceuticalForm),
    strength: toLocalizedText(extracted.strength),
    feedClassification: toLocalizedText(extracted.feedClassification),
    activeIngredients: ingredients.length > 0
      ? ingredients.map((i) => ({
          translations: { en: i.name || "" },
          primary: "en",
          amount: i.concentration || i.amount || "q.s.",
          unit: null,
          normalizedName: (i.name || "").toLowerCase() || null,
        }))
      : [{ translations: { en: "Unknown" }, primary: "en", amount: "q.s.", unit: null, normalizedName: null }],
    excipients: [],
    analysis: null,
    targetAnimalSpecies: {
      translations: { en: (extracted.targetAnimalSpeciesList || []).join(", ") || "Unknown" },
      primary: "en",
      list: Array.isArray(extracted.targetAnimalSpeciesList) && extracted.targetAnimalSpeciesList.length > 0
        ? extracted.targetAnimalSpeciesList
        : ["Unknown"],
      source: "inferred", // extracted from the uploaded document itself, not a matched reference
    },
    aimOfUse: toLocalizedText(extracted.aimOfUse) || { translations: { en: "" }, primary: "en" },
    indications: [],
    routeOfAdministration: toLocalizedText(extracted.routeOfAdministration),
    directionOfUse: toLocalizedText(extracted.directionOfUse) || { translations: { en: "" }, primary: "en" },
    contraindications: null,
    warnings: [],
    sideEffects: null,
    withdrawalPeriod: toLocalizedText(extracted.withdrawalPeriod),
    userSafety: [],
    storage: toLocalizedText(extracted.storage) || { translations: { en: "" }, primary: "en" },
    shelfLifeAfterOpening: null,
    disposal: null,
    netWeight: toLocalizedText(extracted.netWeight) || { translations: { en: "" }, primary: "en" },
    packaging: toLocalizedText(extracted.packaging),
    registrationNumber: extracted.registrationNumber || null,
    marketingAuthorisationHolder: null,
    manufacturer: toLocalizedText(extracted.manufacturer),
    importer: toLocalizedText(extracted.importer),
    countryOfProduction: toLocalizedText(country),
    batchNo: extracted.batchNo || null,
    productionDate: extracted.productionDate || null,
    expiryDate: extracted.expiryDate || null,
    prescriptionStatus: "NA",
    usageDeclaration: [],
    keepOutOfReachOfChildren: true,
    estimatedFields: [],
  };
}

// §14.5's item 5 fix: always emits meta for target species, even when the
// model read nothing. Previously the extractionMeta.targetAnimalSpecies entry
// was only built when the list was non-empty, so a failed pictogram read fell
// straight through to mapToLabelData's ["Unknown"] fallback with NO
// extractionMeta entry at all — invisible to checkExtractionConfidence, so a
// required field the extractor could not read silently looked like a normal
// PASS instead of NEEDS_CONFIRMATION. Exported for direct unit testing.
export function buildSpeciesExtractionMeta(extracted) {
  const speciesList = Array.isArray(extracted.targetAnimalSpeciesList) ? extracted.targetAnimalSpeciesList : [];
  const speciesMeta = extracted.extractionMeta?.targetAnimalSpeciesList;
  const found = speciesList.length > 0;
  return {
    confidence: found ? (speciesMeta?.confidence ?? 0.95) : 0,
    snippet: found ? speciesList.join(", ") : "No species text or pictogram was read from the label.",
    bbox: null,
    region: speciesMeta?.region ?? null,
    ambiguous: found ? (speciesMeta?.ambiguous ?? false) : true,
  };
}

async function callGeminiWithRetry(parts, label = "Gemini") {
  const modelSpec = MODELS.EXTRACT;
  try {
    const response = await geminiClient.generateContentWithRetry({
      model: modelSpec.id,
      contents: parts,
      config: { temperature: modelSpec.temperature, thinkingConfig: { thinkingBudget: modelSpec.thinkingBudget } },
    });
    return response.text;
  } catch (error) {
    throw new AppError(`[${label}] ${error.message}`, 500);
  }
}

function parseGeminiJson(raw) {
  let clean = raw.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  return JSON.parse(clean.trim());
}

/**
 * Extracts a labelSchema-shaped labelData object from an uploaded label file,
 * plus supplementary (non-judgemental) DB match context. Makes exactly one AI
 * call — no compliance/validation reasoning happens here. Extraction of the
 * label's content has no tenant concept, but matching it against a Product
 * row does (§14.5.1, Invariant #10) — companyId is threaded through only for
 * that step, never to change what gets extracted from the file.
 */
export const extract = async (fileBuffer, fileName, mimeType, country, companyId, onProgress) => {
  if (!process.env.GEMINI_API_KEY && process.env.MOCK_GEMINI !== "true") {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  const reportProgress = (progress, message) => {
    if (typeof onProgress === "function") onProgress(progress, message);
  };

  reportProgress(5, "Initializing AI");

  const ext = path.extname(fileName) || (mimeType === "application/pdf" ? ".pdf" : ".png");
  const tempFilePath = path.join(process.cwd(), `temp_label_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);
  fs.writeFileSync(tempFilePath, fileBuffer);

  let uploadResult = null;
  const isMockMode = process.env.MOCK_GEMINI === "true" || !process.env.GEMINI_API_KEY;

  try {
    let extracted;

    if (isMockMode) {
      console.warn(`[LabelExtractor] MOCK MODE active — returning placeholder extraction, not a real analysis.`);
      extracted = {
        productName: "H-VIRAL",
        productType: "feed_additive",
        activeIngredients: [{ name: "Olive Leaves", concentration: "10%" }, { name: "Sorbitol", concentration: "5%" }],
        targetAnimalSpeciesList: ["Poultry"],
        extractionMeta: { targetAnimalSpeciesList: { confidence: 0.9, ambiguous: false } },
        aimOfUse: "Immune support and stress relief.",
        directionOfUse: "1-2 ml per Litre",
        storage: "Store below 25C",
        netWeight: "1L",
      };
    } else {
      reportProgress(15, "Uploading label");
      uploadResult = await geminiClient.uploadFile(tempFilePath, { mimeType, displayName: fileName });

      let file = await geminiClient.getFile(uploadResult.name);
      let attempts = 0;
      while (file.state === "PROCESSING" && attempts < 12) {
        await new Promise((r) => setTimeout(r, 5000));
        file = await geminiClient.getFile(uploadResult.name);
        attempts++;
      }
      if (file.state !== "ACTIVE") {
        throw new AppError(`Gemini file processing failed. State: ${file.state}`, 500);
      }

      reportProgress(40, "Extracting label content");
      const fileRef = { fileData: { mimeType: uploadResult.mimeType, fileUri: uploadResult.uri } };

      const extractPrompt = `
You are extracting the content of a veterinary/animal-feed product label — EXTRACTION ONLY.
Do not judge compliance, do not compare against any regulation, do not decide pass/fail.

Read the WHOLE label, not just body text: target species are very often shown as
PICTOGRAMS/ICONS (e.g. chicken, cattle, sheep, horse, camel) printed across the top
of the label or elsewhere in the artwork, not written out as words. Identify every
species icon you can see and list the species it depicts in "targetAnimalSpeciesList" —
do not limit yourself to species mentioned in running text. Also read any other
information conveyed through package artwork/graphics (tables, diagrams, warning
symbols), not only paragraph text.

Return ONLY a raw JSON object with whatever of these fields the label visibly states
(use null for anything not stated — do not guess or invent):
{
  "productName": "string or null",
  "productType": "one of veterinary_drug|feed_additive|premix|supplement|compound_feed — your best reading of the label, or null",
  "pharmaceuticalForm": "string or null",
  "strength": "string or null",
  "feedClassification": "string or null",
  "activeIngredients": [{ "name": "string", "concentration": "string" }],
  "targetAnimalSpeciesList": ["string"],
  "aimOfUse": "string or null",
  "routeOfAdministration": "string or null",
  "directionOfUse": "string or null",
  "withdrawalPeriod": "string or null",
  "storage": "string or null",
  "netWeight": "string or null",
  "packaging": "string or null",
  "registrationNumber": "string or null",
  "manufacturer": "string or null",
  "importer": "string or null",
  "batchNo": "string or null",
  "productionDate": "string or null",
  "expiryDate": "string or null",
  "extractionMeta": {
    "targetAnimalSpeciesList": {
      "confidence": "number 0-1 — how sure you are you found EVERY species shown (icons included); 0 if you saw no species text or icons at all",
      "ambiguous": "boolean — true if any icon/text was unclear or you are not confident the list is complete",
      "region": "string or null — brief description of where on the label you read species from, e.g. 'pictogram row, top of label'"
    }
  }
}
Do not include markdown formatting.
      `.trim();

      const raw = await callGeminiWithRetry([fileRef, extractPrompt], "Extract");
      extracted = parseGeminiJson(raw);
    }

    reportProgress(70, "Searching database");
    const { dbProduct, isExactMatch, existsInDb, matchState, matchTier, matchScore } = await matchProduct(extracted, country, companyId);

    let safeDbProduct = null;
    if (dbProduct) {
      // eslint-disable-next-line no-unused-vars
      const { password, companyId: _cid, ...rest } = dbProduct;
      safeDbProduct = rest;
    }

    reportProgress(90, "Mapping to label schema");
    const labelData = mapToLabelData(extracted, country);

    // Build extractionMeta (§14.5.3) for each field
    const extractionMeta = {};
    const topKeys = [
      "productName", "pharmaceuticalForm", "strength", "feedClassification",
      "aimOfUse", "routeOfAdministration", "directionOfUse", "withdrawalPeriod",
      "storage", "netWeight", "packaging", "registrationNumber", "manufacturer",
      "importer", "batchNo", "productionDate", "expiryDate",
    ];
    for (const key of topKeys) {
      if (extracted[key]) {
        extractionMeta[key] = {
          confidence: extracted.extractionMeta?.[key]?.confidence ?? 0.95,
          snippet: extracted[key],
          bbox: extracted.extractionMeta?.[key]?.bbox ?? null,
          ambiguous: extracted.extractionMeta?.[key]?.ambiguous ?? false,
        };
      }
    }
    if (extracted.activeIngredients && extracted.activeIngredients.length > 0) {
      extractionMeta.activeIngredients = {
        confidence: extracted.extractionMeta?.activeIngredients?.confidence ?? 0.95,
        snippet: JSON.stringify(extracted.activeIngredients),
        bbox: null,
        ambiguous: false,
      };
    }
    extractionMeta.targetAnimalSpecies = buildSpeciesExtractionMeta(extracted);

    return {
      labelData,
      extractionMeta,
      dbMatch: { existsInDb, isExactMatch, dbProduct: safeDbProduct, matchState, matchTier, matchScore },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`Failed to extract label: ${error.message}`, 500);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (_) {}
    }
    if (uploadResult?.name) {
      try { await geminiClient.deleteFile(uploadResult.name); } catch (_) {}
    }
  }
};
