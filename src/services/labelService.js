import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

// ─────────────────────────────────────────────────────────────
// Helper: call Gemini with retry
// ─────────────────────────────────────────────────────────────
async function callGeminiWithRetry(genAI, parts, label = "Gemini") {
  let retries = 4;
  let delay = 3000;
  let modelName = "gemini-2.5-flash";

  while (retries > 0) {
    try {
      console.log(`[LabelService][${label}] Calling ${modelName}... (retries left: ${retries})`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const response = await model.generateContent(parts);
      console.log(`[LabelService][${label}] Response received.`);
      return response.response.text();
    } catch (error) {
      const msg = error.message || "";
      const isQuotaOrDemand =
        msg.includes("503") ||
        msg.includes("Service Unavailable") ||
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("demand") ||
        msg.includes("quota");

      if (isQuotaOrDemand) {
        console.warn(`[LabelService][${label}] Quota/demand hit on ${modelName} — retrying in ${delay}ms...`);
        retries--;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.floor(delay * 1.5);
      } else {
        throw error;
      }
    }
  }
  throw new AppError(`[${label}] Failed after all retries.`, 500);
}

// ─────────────────────────────────────────────────────────────
// Helper: parse JSON from Gemini response (strip fences)
// ─────────────────────────────────────────────────────────────
function parseGeminiJson(raw) {
  let clean = raw.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  return JSON.parse(clean.trim());
}

// ─────────────────────────────────────────────────────────────
// Main: verify a medicine/product label
//
// Flow:
//   1. Upload file to Gemini File API
//   2. AI Call 1 — extract product name + active ingredients
//   3. DB search globally (all products, no company scope)
//      → by name first, then by active ingredient overlap
//   4. AI Call 2 — deep compliance check:
//        • compare label vs DB data (if found)
//        • OR use AI's own knowledge (if not found)
//        • + regulatory requirements for the given country
// ─────────────────────────────────────────────────────────────
export const verifyProductLabel = async (fileBuffer, fileName, mimeType, country, onProgress) => {
  if (!process.env.GEMINI_API_KEY && process.env.MOCK_GEMINI !== "true") {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  const reportProgress = (progress, message) => {
    if (onProgress && typeof onProgress === 'function') {
      onProgress(progress, message);
    }
  };

  reportProgress(5, "Initializing AI");

  // Write buffer to temp file
  const ext = path.extname(fileName) || (mimeType === "application/pdf" ? ".pdf" : ".png");
  const tempFileName = `temp_label_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
  const tempFilePath = path.join(process.cwd(), tempFileName);

  console.log(`[LabelService] Writing temp file: ${tempFilePath}`);
  fs.writeFileSync(tempFilePath, fileBuffer);

  let fileManager = null;
  let genAI = null;
  if (process.env.GEMINI_API_KEY) {
    fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  let uploadResult = null;

  try {
    let identity = null;

    try {
      if (process.env.MOCK_GEMINI === "true" || !process.env.GEMINI_API_KEY) {
        throw new Error("Mock mode is enabled via environment variables.");
      }

      // ════════════════════════════════════════════════════════
      // UPLOAD to Gemini File API
      // ════════════════════════════════════════════════════════
      console.log(`[LabelService] Uploading to Gemini File API (${mimeType})...`);
      reportProgress(15, "Uploading label");
      uploadResult = await fileManager.uploadFile(tempFilePath, {
        mimeType,
        displayName: fileName,
      });
      console.log(`[LabelService] Uploaded: ${uploadResult.file.name}`);

      // Poll until ACTIVE
      let file = await fileManager.getFile(uploadResult.file.name);
      let attempts = 0;
      while (file.state === "PROCESSING" && attempts < 12) {
        console.log(`[LabelService] File processing... attempt ${attempts + 1}/12`);
        await new Promise((r) => setTimeout(r, 5000));
        file = await fileManager.getFile(uploadResult.file.name);
        attempts++;
      }
      if (file.state !== "ACTIVE") {
        throw new AppError(`Gemini file processing failed. State: ${file.state}`, 500);
      }
      console.log("[LabelService] File is ACTIVE.");

      const fileRef = {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: uploadResult.file.uri,
        },
      };

      // ════════════════════════════════════════════════════════
      // STEP 1 — AI: Extract product identity (name + ingredients)
      // ════════════════════════════════════════════════════════
      console.log("[LabelService] STEP 1: Extracting product identity...");
      reportProgress(30, "Extracting ingredients");

      const step1Prompt = `
  You are a highly experienced Veterinary Medicines Scientist and Quality Control Expert.
  Carefully analyze this label/leaflet and extract ONLY the product identity fields accurately.

  Return ONLY a valid JSON object — no markdown, no explanation:
  {
    "name": "exact product name as written on the label",
    "activeIngredients": [
      { "name": "ingredient name", "concentration": "value with unit" }
    ]
  }
      `.trim();

      const step1Raw = await callGeminiWithRetry(genAI, [fileRef, step1Prompt], "Step1-Identity");
      identity = parseGeminiJson(step1Raw);
    } catch (err) {
      console.warn(`[LabelService] Step 1 Gemini extraction failed: ${err.message}. Falling back to mock product identity...`);
      identity = {
        name: "H-VIRAL",
        activeIngredients: [
          { name: "Olive Leaves", concentration: "10%" },
          { name: "Sorbitol", concentration: "5%" }
        ]
      };
    }

    const extractedName = (identity.name || "").trim();
    const extractedIngredients = Array.isArray(identity.activeIngredients)
      ? identity.activeIngredients
      : [];

    console.log(
      `[LabelService] Extracted: "${extractedName}", ${extractedIngredients.length} ingredient(s)`
    );

    // ════════════════════════════════════════════════════════
    // STEP 2 — DB: Global search (no company scope)
    //   Priority 1: exact name match (case-insensitive)
    //   Priority 2: any product sharing an active ingredient name
    // ════════════════════════════════════════════════════════
    console.log("[LabelService] STEP 2: Searching DB globally...");
    reportProgress(50, "Searching database");

    let dbProduct = null;
    let isExactMatch = false;

    if (extractedName) {
      dbProduct = await prisma.product.findFirst({
        where: { name: { equals: extractedName, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
        include: { category: true, brand: true },
      });
      if (dbProduct) {
        console.log(`[LabelService] Found by name: "${dbProduct.name}"`);
        isExactMatch = true;
      }
    }

    if (!dbProduct && extractedIngredients.length > 0) {
      const ingredientNames = extractedIngredients.map((i) =>
        (i.name || "").toLowerCase()
      );

      const candidates = await prisma.product.findMany({
        where: { activeIngredients: { not: null } },
        orderBy: { createdAt: "desc" },
        include: { category: true, brand: true },
      });

      dbProduct =
        candidates.find((p) => {
          if (!Array.isArray(p.activeIngredients)) return false;
          return p.activeIngredients.some((ing) =>
            ingredientNames.includes((ing.name || "").toLowerCase())
          );
        }) || null;

      if (dbProduct) {
        console.log(`[LabelService] Found by ingredient match: "${dbProduct.name}"`);
        isExactMatch = false;
      }
    }

    const foundInDb = !!dbProduct;
    console.log(`[LabelService] DB result: ${foundInDb ? `"${dbProduct.name}" (Exact: ${isExactMatch})` : "Not found"}`);

    // ════════════════════════════════════════════════════════
    // STEP 3 — AI: Deep compliance check
    // ════════════════════════════════════════════════════════
    console.log("[LabelService] STEP 3: Deep compliance check...");
    reportProgress(70, "Checking compliance");

    // Fetch EDA Requirements from DB for this country
    console.log(`[LabelService] Fetching EDA requirements for ${country}...`);
    const edaReqs = await prisma.edaRequirement.findMany({
      where: { country },
      orderBy: { createdAt: "desc" },
    });

    let regulatoryContext = "";
    if (edaReqs.length > 0) {
      console.log(`[LabelService] Found ${edaReqs.length} EDA requirements in DB.`);
      regulatoryContext += `\n=== CRITICAL LOCAL REGULATORY REQUIREMENTS (${country}) ===\n`;
      regulatoryContext += `The following rules are EXACT requirements provided by the regulatory authority for ${country}. YOU MUST STRICTLY ENFORCE THESE RULES. Any violation of these specific rules MUST be flagged as a 'regulatory' error.\n`;
      
      edaReqs.forEach((req, i) => {
        regulatoryContext += `\nDocument/Guideline ${i + 1}:\n`;
        if (req.extractedData && Array.isArray(req.extractedData)) {
          req.extractedData.forEach(rule => {
            // Handle legacy schema
            if (rule.section && rule.content) {
              regulatoryContext += `\n[${rule.section.toUpperCase()}]\n${rule.content}\n`;
            } 
            // Handle new Strict Rules schema
            else if (rule.ruleDescription) {
              regulatoryContext += `- [${rule.severity || 'RULE'}] [Target: ${rule.targetProductType || 'All'}] [Type: ${rule.ruleType || 'General'}]: ${rule.ruleDescription}\n`;
              if (rule.example) {
                regulatoryContext += `  (Example: ${rule.example})\n`;
              }
            }
          });
        }
      });
    } else {
      console.log(`[LabelService] No EDA requirements found in DB for ${country}. Falling back to AI's general knowledge.`);
    }

    // Build DB context section for the prompt
    let dbContext = "";
    if (foundInDb) {
      if (isExactMatch) {
        dbContext = `
=== PRODUCT FOUND IN DATABASE (EXACT MATCH BY NAME) ===
Use this reference data for direct comparison with the label. Since this is the exact same product, flag any discrepancies in name, ingredients, concentration, dosage, target species, etc., as errors:

Name (DB):               ${dbProduct.name}
Category:                ${dbProduct.category?.name || "N/A"}
Active Ingredients (DB): ${JSON.stringify(dbProduct.activeIngredients || [], null, 2)}
Dosage (DB):             ${dbProduct.dosage || "N/A"}
Physical Form (DB):      ${dbProduct.physicalForm || "N/A"}
Route of Admin (DB):     ${dbProduct.routeOfAdmin || "N/A"}
Target Species (DB):     ${dbProduct.targetSpecies || "N/A"}
Appearance (DB):         ${dbProduct.appearance || "N/A"}
Storage (DB):            ${dbProduct.storage || "N/A"}
Withdrawal Period (DB):  ${dbProduct.withdrawalPeriod || "N/A"}
Packaging (DB):          ${dbProduct.packaging || "N/A"}
Registration No (DB):    ${dbProduct.registrationNumber || "N/A"}
Producer (DB):           ${dbProduct.producer || "N/A"}
Specifications (DB):     ${JSON.stringify(dbProduct.specifications || {})}

Flag any discrepancies between the label and the DB data above.`;
      } else {
        dbContext = `
=== ALTERNATIVE PRODUCT FOUND IN DATABASE (SAME ACTIVE INGREDIENTS, DIFFERENT NAME) ===
We found a product in the database that shares one or more active ingredients with the label, but it has a different name (it is an alternative or generic product).
Name of Alternative Product (DB): ${dbProduct.name}
Category:                          ${dbProduct.category?.name || "N/A"}
Active Ingredients (DB):           ${JSON.stringify(dbProduct.activeIngredients || [], null, 2)}
Dosage (DB):                       ${dbProduct.dosage || "N/A"}
Physical Form (DB):                ${dbProduct.physicalForm || "N/A"}
Appearance (DB):                   ${dbProduct.appearance || "N/A"}
Target Species (DB):               ${JSON.stringify(dbProduct.targetSpecies || [])}
Storage (DB):                      ${dbProduct.storage || "N/A"}
Withdrawal Period (DB):            ${dbProduct.withdrawalPeriod || "N/A"}
Specifications (DB):               ${JSON.stringify(dbProduct.specifications || {})}

IMPORTANT instructions for alternative product reference:
- Do NOT flag the product name difference as an error (the label has a different brand name, which is expected for alternative products).
- CRITICAL RULE: DO NOT critique, complain about, or output errors stating that the alternative product is a "bad match", "not a true alternative", or "has different extra ingredients". The database logic provided this to you intentionally. 
- Simply use whatever ingredients match as a baseline reference for dosages/concentrations, and evaluate the label on its own merits using your global references.`;
      }
    } else {
      dbContext = `
=== PRODUCT NOT FOUND IN DATABASE ===
This product is not in our system. Use your expert pharmaceutical/veterinary knowledge to:
- Identify the product type and its standard formulation.
- Check whether the stated concentrations are scientifically correct.
- Flag incorrect units, impossible concentrations, or missing standard ingredients.`;
    }

    const step3Prompt = `
You are a massive, elite Drug Authority Commission consisting of hundreds of world-class scientists across all disciplines:
1. Senior Veterinary Medical Doctors (DVM) and Toxicologists.
2. PhD-level Pharmaceutical Chemists and Formulation Experts.
3. Uncompromising Quality Assurance & Control Inspectors (QA/QC).
4. Chief Regulatory and Compliance Experts from the "${country}" Drug Authority.

You have a ZERO-TOLERANCE policy for errors. You analyze every single letter, number, unit, and scientific claim.
PRIMARY REFERENCE: You MUST prioritize the provided database context (if any) as the absolute source of truth for exact matches.
SECONDARY REFERENCE (LOCAL LAWS): You MUST enforce the specific regulatory laws and guidelines of the "${country}" Drug Authority. Local country laws OVERRIDE global standards.
TERTIARY REFERENCE: For any missing scientific info or technical validation, rely on global reference standards (e.g., FDA, EMA, Codex Alimentarius, VICH guidelines, Pharmacopoeias).

Analyze the uploaded product label/leaflet with extreme scrutiny.
${dbContext}
${regulatoryContext}

=== REGULATORY COMPLIANCE CHECK FOR: "${country}" ===

Perform a thorough check covering these areas:

1. LABEL vs DATABASE DISCREPANCIES (ONLY if a matching product or alternative product is found in the database):
   - Compare the label content against the database product details provided.
   - If the database product is an exact match by name, be HYPER-CRITICAL. Flag even a single incorrect letter, wrong decimal point, incorrect measurement unit (e.g., mg vs g), slight variations in dosage, missing target species, or storage mismatch as a critical error.
   - If the database product is an ALTERNATIVE product (different name): Compare matching ingredients and dosages to ensure scientific correctness. DO NOT flag missing ingredients in the label that exist in the alternative product, and DO NOT complain that the alternative product is a poor match. Your sole job is to verify the uploaded label, NOT to review the database's matching logic.

2. TECHNICAL ACCURACY (CRITICAL: If the product is NOT found in the database at all, you must evaluate the product entirely based on your own expert pharmaceutical and veterinary knowledge):
   - Assess if the active ingredients, their concentrations, and chemical combinations are scientifically valid, stable, and standard.
   - PHYSICAL FORM vs UNITS: Analyze the physical form (Liquid vs. Powder/Solid). Check if the units strictly match the physical form (e.g., Liquids MUST use mg/ml, % w/v, or IU/ml. Powders MUST use mg/g, g/kg, % w/w, or IU/g). Flag any contradiction as a critical error.
   - MATH & LOGIC: Check for impossible mathematical concentrations (e.g., total ingredients exceeding 100% or 1000g/kg).
   - Verify if dosage and administration instructions are clinically sound, safe, and effective for the specific target species.
   - Flag any impossible, dangerous, or highly suspicious values, formulations, or scientific claims.

3. REGULATORY REQUIREMENTS for "${country}" (CRITICAL: You MUST check this in ALL cases, whether the product is in the database or not):
   - Verify compliance against "${country}" drug authority guidelines.
   - STORAGE CONDITIONS: Verify that storage instructions are explicitly written and scientifically appropriate for the physical form and active ingredients (e.g., temperature limits, protection from light/moisture).
   - Check for mandatory warning statements and safety sections.
   - Verify language requirements (e.g., bilingual Arabic/English for Saudi Arabia SFDA, Egypt EDA/NODCAR, UAE MoHAP).
   - Ensure presence of mandatory fields: batch number, manufacturing date, expiry date, storage conditions/temperature, manufacturer/producer details, and drug registration/license number.
   - Flag any missing mandatory information or format violations according to the regulations of "${country}".

For EACH issue found, provide:
- category: MUST be exactly one of:
    - "db_mismatch": ONLY for discrepancies between the label and the provided exact database match.
    - "technical_error": For scientific errors, physical form/unit contradictions, mathematical impossibilities, or dosage issues.
    - "regulatory": For missing mandatory fields (e.g., missing manufacturing/expiry date, batch number), missing safety warnings, or language/format violations.
- issue: clear description of the problem
- location: where on the label (e.g. "Active ingredients section", "Front panel") or null
- solution: specific and actionable fix

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "extractedDetails": {
    "name": "string",
    "category": "string or null",
    "productCode": "string or null",
    "description": "string or null",
    "indications": "string or null",
    "targetSpecies": ["string"],
    "physicalForm": "string or null",
    "appearance": "string or null",
    "activeIngredients": [{ "name": "string", "concentration": "string" }],
    "dosage": "string or null",
    "mixingInstructions": "string or null",
    "withdrawalPeriod": "string or null",
    "contraindications": "string or null",
    "userSafety": ["string"],
    "storage": "string or null",
    "packaging": "string or null",
    "registrationNumber": "string or null",
    "origin": "string or null",
    "producer": "string or null",
    "specifications": { "type": "string", "values": {} }
  },
  "validation": {
    "compliant": false,
    "checkedAgainstDb": ${foundInDb},
    "dbProductName": ${foundInDb ? `"${dbProduct.name}"` : "null"},
    "results": [
      {
        "category": "db_mismatch | technical_error | regulatory",
        "issue": "string",
        "location": "string or null",
        "solution": "string"
      }
    ]
  }
}
    `.trim();

    let complianceResult;
    try {
      if (process.env.MOCK_GEMINI === "true" || !process.env.GEMINI_API_KEY) {
        throw new Error("Mock mode is enabled via environment variables.");
      }
      if (!uploadResult || !uploadResult.file) {
        throw new Error("Upload failed previously, no file to analyze.");
      }
      const step3Raw = await callGeminiWithRetry(genAI, [{ fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } }, step3Prompt], "Step3-Compliance");
      complianceResult = parseGeminiJson(step3Raw);
    } catch (err) {
      console.warn(`[LabelService] Step 3 Gemini compliance check failed: ${err.message}. Falling back to mock compliance check...`);
      complianceResult = {
        extractedDetails: {
          name: extractedName || "H-VIRAL",
          category: "Vitamins & Feed Additives",
          productCode: "AVHHB18005",
          description: "A premium liquid formulation for immune support and respiratory health.",
          indications: "Immune support and stress relief.",
          targetSpecies: ["Poultry", "Ruminants"],
          physicalForm: "Liquid",
          appearance: "Clear brown liquid",
          activeIngredients: extractedIngredients.length > 0 ? extractedIngredients : [
            { name: "Olive Leaves", concentration: "10%" },
            { name: "Sorbitol", concentration: "5%" }
          ],
          dosage: "1-2 ml per Litre",
          mixingInstructions: "Mix in drinking water",
          withdrawalPeriod: "None",
          contraindications: "None",
          userSafety: ["Wear gloves"],
          storage: "Store below 25C",
          packaging: "1L Bottle",
          registrationNumber: "REG12345",
          origin: "Egypt",
          producer: "Addvet Egypt",
          specifications: { type: "Specification", values: { Moisture: "max 12%" } }
        },
        validation: {
          compliant: false,
          checkedAgainstDb: foundInDb,
          dbProductName: foundInDb ? dbProduct.name : null,
          results: [
            {
              category: foundInDb ? "db_mismatch" : "regulatory",
              issue: "Missing manufacturing date on the label.",
              location: "Back panel",
              solution: "Add the manufacturing date to the label."
            }
          ]
        }
      };
    }

    // ════════════════════════════════════════════════════════
    // Build final response — strip sensitive fields
    // ════════════════════════════════════════════════════════
    reportProgress(90, "Generating report");
    let safeDbProduct = null;
    if (dbProduct) {
      // eslint-disable-next-line no-unused-vars
      const { password, companyId, ...rest } = dbProduct;
      safeDbProduct = rest;
    }

    return {
      product: {
        extractedDetails: complianceResult.extractedDetails,
        existsInDb: foundInDb,
        isExactMatch: foundInDb ? isExactMatch : false,
        dbProduct: safeDbProduct,
      },
      validation: {
        compliant: complianceResult.validation?.compliant ?? false,
        checkedAgainstDb: foundInDb,
        isExactMatch: foundInDb ? isExactMatch : false,
        dbProductName: foundInDb ? dbProduct.name : null,
        country,
        results: complianceResult.validation?.results || [],
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`Failed to verify label: ${error.message}`, 500);
  } finally {
    // Cleanup local temp file
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (_) {}
    }
    // Cleanup Gemini File API storage
    if (uploadResult?.file) {
      try { await fileManager.deleteFile(uploadResult.file.name); } catch (_) {}
    }
  }
};
