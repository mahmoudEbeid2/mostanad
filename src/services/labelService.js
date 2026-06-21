import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

/**
 * Verify medicine label PDF or image, extract details, and perform regulatory checks using Gemini AI.
 */
export const verifyProductLabel = async (companyId, fileBuffer, fileName, mimeType, country) => {
  if (!process.env.GEMINI_API_KEY) {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  // 1. Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new AppError("Target company not found!", 404);
  }

  // 2. Write buffer to a temp file in the workspace
  const extension = path.extname(fileName) || (mimeType === "application/pdf" ? ".pdf" : ".png");
  const tempFileName = `temp_label_${Date.now()}_${Math.random().toString(36).substring(7)}${extension}`;
  const tempFilePath = path.join(process.cwd(), tempFileName);

  console.log(`[LabelService] Writing temp file to ${tempFilePath}...`);
  fs.writeFileSync(tempFilePath, fileBuffer);

  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  let uploadResult = null;
  let parsedAIResponse = null;

  try {
    // 3. Upload file to Gemini File API
    console.log(`[LabelService] Uploading file to Gemini File API (MimeType: ${mimeType})...`);
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: mimeType,
      displayName: fileName,
    });
    console.log(`[LabelService] Upload succeeded. File Name: ${uploadResult.file.name}, URI: ${uploadResult.file.uri}`);

    // 4. Poll for the file to be processed (state ACTIVE)
    console.log("[LabelService] Polling file state...");
    let file = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (file.state === "PROCESSING" && attempts < 12) {
      console.log(`[LabelService] File state is processing. Attempt ${attempts + 1}/12. Waiting 5s...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      file = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }
    console.log(`[LabelService] File state is now: ${file.state}`);

    if (file.state !== "ACTIVE") {
      throw new AppError(`File processing failed at Gemini API. State: ${file.state}`, 500);
    }

    // 5. Invoke Gemini model
    console.log("[LabelService] Invoking Gemini model for label extraction and compliance validation...");

    const prompt = `
      You are an expert pharmaceutical and veterinary drug regulatory affairs specialist.
      Analyze the uploaded PDF or image drug/supplement label or leaflet.

      STEP 1: Extract the product information.
      Extract the following fields from the label/leaflet. If any fields are not explicitly present in the text, you must use your domain knowledge to infer and estimate highly accurate, standard, and professional values for them (except for country of origin, which should be set to null if not explicitly mentioned).
      The extracted fields are:
      - name: Exact product name.
      - category: Product category (e.g. "Antibiotics", "Vitamins", "Feed Additive").
      - productCode: Product code if available (or null).
      - description: Description of the product.
      - indications: Indications, purposes, or benefits.
      - targetSpecies: List of target species (e.g., ["Broiler", "Sheep", "Cattle"]) if applicable. Array of strings.
      - physicalForm: Physical form (e.g., "Liquid", "Powder").
      - appearance: Visual appearance/color.
      - activeIngredients: Array of active ingredients with concentrations, formatted as objects: [{"name": "L-Lysine", "concentration": "98.5%"}].
      - dosage: Dosage and administration instructions.
      - mixingInstructions: Mixing instructions.
      - withdrawalPeriod: Withdrawal period if applicable.
      - contraindications: Contraindications or warnings.
      - userSafety: Array of safety instructions for the user.
      - storage: Storage conditions.
      - packaging: Pack size or packaging type.
      - registrationNumber: Registration or license number.
      - origin: Country of origin (set to null if not explicitly mentioned).
      - producer: Producer/manufacturer name.
      - specifications: Specifications/matrix values (e.g., {"type": "Specification", "values": {"pH": "...", "Assay": "..."}}).

      STEP 2: Regulatory compliance check for target country: "${country}".
      Assess whether the label meets the regulatory labeling requirements for pharmaceutical, supplement, or veterinary products of the specified target country: "${country}".
      Check details such as:
      - Whether required warning statements, language requirements (e.g. bilingual Arabic/English for Gulf countries like Saudi Arabia/SFDA or Egypt/EDA), storage temperature statements, active ingredient labeling, batch/expiry placeholders, and manufacturing details are correct and present.
      - Identify any non-compliance issues (e.g. missing warnings, wrong language, missing storage temperature specifications, missing drug registration number or warning sections required by that country).
      - For each issue, provide a clear, actionable solution/fix.

      Return the output ONLY as a valid JSON object matching the schema below.
      Do not include any chat, markdown code blocks, or explanations outside the JSON object.

      {
        "extractedDetails": {
          "name": "string",
          "category": "string",
          "productCode": "string or null",
          "description": "string or null",
          "indications": "string or null",
          "targetSpecies": ["string"],
          "physicalForm": "string or null",
          "appearance": "string or null",
          "activeIngredients": [
            {
              "name": "string",
              "concentration": "string"
            }
          ],
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
          "specifications": {
            "type": "string",
            "values": {
              "key": "value"
            }
          }
        },
        "validation": {
          "compliant": boolean,
          "issues": ["string"],
          "solutions": ["string"]
        }
      }
    `;

    let resultText = "";
    let success = false;
    let retries = 4;
    let delay = 3000;
    let currentModelName = "gemini-2.5-flash";

    while (retries > 0 && !success) {
      try {
        console.log(`[LabelService] Calling generateContent with model ${currentModelName}... (Retries left: ${retries})`);
        const activeModel = genAI.getGenerativeModel({ model: currentModelName });
        const response = await activeModel.generateContent([
          {
            fileData: {
              mimeType: uploadResult.file.mimeType,
              fileUri: uploadResult.file.uri,
            },
          },
          prompt,
        ]);
        console.log("[LabelService] Received response from model!");
        resultText = response.response.text();
        success = true;
      } catch (error) {
        console.warn(`[LabelService] Error during generateContent: ${error.message}`);
        const errMsg = error.message || "";
        const isQuotaOrDemand = 
          errMsg.includes("503") || 
          errMsg.includes("Service Unavailable") || 
          errMsg.includes("429") || 
          errMsg.includes("Too Many Requests") ||
          errMsg.includes("demand") ||
          errMsg.includes("quota");

        if (isQuotaOrDemand && currentModelName === "gemini-2.5-flash") {
          console.warn("[LabelService] High demand/quota error detected on gemini-2.5-flash. Falling back to gemini-2.0-flash...");
          currentModelName = "gemini-2.0-flash";
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else if (isQuotaOrDemand) {
          console.warn(`[LabelService] Quota/demand error. Retrying model ${currentModelName} in ${delay}ms...`);
          retries--;
          if (retries === 0) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 1.5;
        } else {
          console.error("[LabelService] Non-quota error, throwing immediately.");
          throw error;
        }
      }
    }

    // Clean up Gemini Markdown formatting if returned
    let cleanJson = resultText.trim();
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.substring(7);
    }
    if (cleanJson.endsWith("```")) {
      cleanJson = cleanJson.substring(0, cleanJson.length - 3);
    }
    cleanJson = cleanJson.trim();

    parsedAIResponse = JSON.parse(cleanJson);
  } catch (error) {
    throw new AppError(`Failed to verify label: ${error.message}`, 500);
  } finally {
    // 6. Clean up files
    // Delete local temp file
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (_) {}
    }
    // Delete file on Gemini API storage
    if (uploadResult && uploadResult.file) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }

  // 7. Check database if the product name already exists for this company
  const productName = parsedAIResponse.extractedDetails.name || "";
  let existingProduct = null;
  if (productName.trim()) {
    existingProduct = await prisma.product.findFirst({
      where: {
        companyId: companyId,
        name: {
          equals: productName.trim(),
          mode: "insensitive",
        },
      },
      include: {
        category: true,
      },
    });
  }

  return {
    product: {
      extractedDetails: parsedAIResponse.extractedDetails,
      existsInDb: !!existingProduct,
      dbProduct: existingProduct,
    },
    validation: {
      compliant: parsedAIResponse.validation.compliant,
      country: country,
      issues: parsedAIResponse.validation.issues,
      solutions: parsedAIResponse.validation.solutions,
    },
  };
};
