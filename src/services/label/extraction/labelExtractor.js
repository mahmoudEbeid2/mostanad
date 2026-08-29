import fs from "fs";
import path from "path";
import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

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

async function findDbMatch(extractedName, extractedIngredients) {
  let dbProduct = null;
  let isExactMatch = false;

  if (extractedName) {
    dbProduct = await prisma.product.findFirst({
      where: { name: { equals: extractedName, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      include: { category: true, brand: true },
    });
    if (dbProduct) isExactMatch = true;
  }

  if (!dbProduct && extractedIngredients.length > 0) {
    const ingredientNames = extractedIngredients.map((i) => (i.name || "").toLowerCase());
    const candidates = await prisma.product.findMany({
      where: { activeIngredients: { not: null } },
      orderBy: { createdAt: "desc" },
      include: { category: true, brand: true },
    });
    dbProduct = candidates.find((p) =>
      Array.isArray(p.activeIngredients) && p.activeIngredients.some((ing) => ingredientNames.includes((ing.name || "").toLowerCase()))
    ) || null;
  }

  return { dbProduct, isExactMatch: !!dbProduct && isExactMatch, existsInDb: !!dbProduct };
}

/**
 * Extracts a labelSchema-shaped labelData object from an uploaded label file,
 * plus supplementary (non-judgemental) DB match context. Makes exactly one AI
 * call — no compliance/validation reasoning happens here. Extraction itself has
 * no tenant concept (a label's content doesn't depend on who uploaded it), so
 * there is no companyId parameter here.
 */
export const extract = async (fileBuffer, fileName, mimeType, country, onProgress) => {
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
Return ONLY a raw JSON object with whatever of these fields the label visibly states (use null for anything not stated — do not guess or invent):
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
  "expiryDate": "string or null"
}
Do not include markdown formatting.
      `.trim();

      const raw = await callGeminiWithRetry([fileRef, extractPrompt], "Extract");
      extracted = parseGeminiJson(raw);
    }

    reportProgress(70, "Searching database");
    const extractedIngredients = Array.isArray(extracted.activeIngredients) ? extracted.activeIngredients : [];
    const { dbProduct, isExactMatch, existsInDb } = await findDbMatch((extracted.productName || "").trim(), extractedIngredients);

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
    if (extracted.targetAnimalSpeciesList && extracted.targetAnimalSpeciesList.length > 0) {
      extractionMeta.targetAnimalSpecies = {
        confidence: extracted.extractionMeta?.targetAnimalSpecies?.confidence ?? 0.95,
        snippet: extracted.targetAnimalSpeciesList.join(", "),
        bbox: null,
        ambiguous: false,
      };
    }

    return { labelData, extractionMeta, dbMatch: { existsInDb, isExactMatch, dbProduct: safeDbProduct } };
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
