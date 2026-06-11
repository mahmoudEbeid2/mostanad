import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

/**
 * Process uploaded PDF catalog using Gemini File API and store categories/products.
 */
export const processCatalogPDF = async (companyId, fileBuffer, fileName = "catalog.pdf") => {
  if (!process.env.GEMINI_API_KEY) {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  // Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new AppError("Target company not found!", 404);
  }

  // 1. Write buffer to a temp file in the workspace
  const tempFileName = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`;
  const tempFilePath = path.join(process.cwd(), tempFileName);
  
  console.log(`[CatalogService] Writing temp file to ${tempFilePath}...`);
  fs.writeFileSync(tempFilePath, fileBuffer);

  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  let uploadResult = null;
  let summary = {
    totalProductsExtracted: 0,
    categoriesCreated: 0,
    categoriesReused: 0,
    productsCreated: 0,
    productsUpdated: 0,
    products: []
  };

  try {
    // 2. Upload file to Gemini File API
    console.log("[CatalogService] Uploading file to Gemini File API...");
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: "application/pdf",
      displayName: fileName,
    });
    console.log(`[CatalogService] Upload succeeded. File Name: ${uploadResult.file.name}, URI: ${uploadResult.file.uri}`);

    // 3. Poll for the file to be processed (state ACTIVE)
    console.log("[CatalogService] Polling file state...");
    let file = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (file.state === "PROCESSING" && attempts < 12) {
      console.log(`[CatalogService] File state is processing. Attempt ${attempts + 1}/12. Waiting 5s...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      file = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }
    console.log(`[CatalogService] File state is now: ${file.state}`);

    if (file.state !== "ACTIVE") {
      throw new AppError(`File processing failed at Gemini API. State: ${file.state}`, 500);
    }

    // 4. Invoke Gemini 2.5 Flash model
    console.log("[CatalogService] Invoking Gemini model...");

    const prompt = `
      You are an expert data extractor specializing in animal feed catalogs and veterinary product labels.
      Analyze the uploaded PDF catalog and extract all individual products.
      
      CRITICAL EXTRACTION & MAPPING QUALITY INSTRUCTIONS:
      1. Read tables and columns side-by-side carefully. Do NOT mix up or merge values (such as ingredients, active concentrations, or dosages) between different columns on the same page.
      2. If a page displays multiple products side-by-side or in separate rows, extract them as separate, independent products.
      3. For each product, extract:
         - name: Exact product name (e.g. "L-LYSINE (Yellow-brownish powder)", "BROILER STARTER CONCENTRATE 5%", "LAYER COMPLEX CONCENTRATE 5").
         - category: Category of the product (e.g., "AMINO ACIDS", "CONCENTRATES", "MINERALS").
         - productCode: Product code if available.
         - description: Description of the product.
         - indications: Benefits, target species, indications, or purposes.
         - targetSpecies: List of target species (e.g., ["Broiler", "Layers", "Poultry", "Ruminants"]). Must be an array of strings.
         - physicalForm: Physical form (e.g., "Powder", "Liquid", "Granule").
         - appearance: Color and visual appearance.
         - activeIngredients: Array of active ingredients with their concentrations if available, formatted as a JSON array of objects: [{"name": "L-Lysine", "concentration": "98.5%"}].
         - dosage: Mixing rates, instructions, or dosage.
         - mixingInstructions: Instructions for mixing.
         - withdrawalPeriod: Withdrawal period details.
         - contraindications: Contraindications or safety concerns.
         - userSafety: Array of safety instructions for the user (e.g. ["Wear gloves", "Avoid inhalation"]).
         - storage: Storage conditions.
         - packaging: Pack size or packaging type (e.g., "25KG Bag", "1L Bottle").
         - registrationNumber: Registration or license number.
         - origin: Country of origin.
         - producer: Producer or manufacturer name.
         - specifications: JSON object representing specifications/matrix values (e.g., {"type": "Specification", "values": {"Moisture": "max 12%", "Purity": "min 98.5%"}}).
      4. INFERENCE OF MISSING DATA: If any fields (like description, indications, targetSpecies, physicalForm, activeIngredients, dosage, mixingInstructions, storage, specifications, userSafety, packaging, producer, registrationNumber) are missing or not explicitly stated in the catalog, you MUST use your domain knowledge to infer and estimate highly accurate, standard, and professional values for them.
         - Do NOT leave fields like targetSpecies, physicalForm, activeIngredients, or specifications blank if they can be logically inferred from the product name and category.
         - EXCEPT FOR COUNTRY OF ORIGIN ('origin'): Do NOT infer the country of origin. If 'origin' is not explicitly mentioned in the text for that product, set it to null.
      
      Return the output ONLY as a valid JSON array of product objects matching the schema below.
      Do not include any chat, markdown code blocks, or explanations outside the JSON array.
      
      [
        {
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
        }
      ]
    `;

    // Try generating content
    let resultText = "";
    let success = false;
    let retries = 4;
    let delay = 3000;
    let currentModelName = "gemini-2.5-flash";

    while (retries > 0 && !success) {
      try {
        console.log(`[CatalogService] Calling generateContent with model ${currentModelName}... (Retries left: ${retries})`);
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
        console.log("[CatalogService] Received response from model!");
        resultText = response.response.text();
        success = true;
      } catch (error) {
        console.warn(`[CatalogService] Error during generateContent: ${error.message}`);
        const errMsg = error.message || "";
        const isQuotaOrDemand = 
          errMsg.includes("503") || 
          errMsg.includes("Service Unavailable") || 
          errMsg.includes("429") || 
          errMsg.includes("Too Many Requests") ||
          errMsg.includes("demand") ||
          errMsg.includes("quota");

        if (isQuotaOrDemand && currentModelName === "gemini-2.5-flash") {
          console.warn("[CatalogService] High demand/quota error detected on gemini-2.5-flash. Falling back to gemini-2.0-flash...");
          currentModelName = "gemini-2.0-flash";
          retries--;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else if (isQuotaOrDemand) {
          console.warn(`[CatalogService] Quota/demand error. Retrying model ${currentModelName} in ${delay}ms...`);
          retries--;
          if (retries === 0) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 1.5;
        } else {
          console.error("[CatalogService] Non-quota error, throwing immediately.");
          throw error;
        }
      }
    }

    // Clean up Gemini Markdown syntax if returned
    let cleanJson = resultText.trim();
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.substring(7);
    }
    if (cleanJson.endsWith("```")) {
      cleanJson = cleanJson.substring(0, cleanJson.length - 3);
    }
    cleanJson = cleanJson.trim();

    const extractedProducts = JSON.parse(cleanJson);
    summary.totalProductsExtracted = extractedProducts.length;

    // 5. Store in Database
    for (const prodData of extractedProducts) {
      // Resolve Category name
      let categoryId = null;
      const categoryName = (prodData.category || "Uncategorized").trim();

      if (categoryName) {
        // Find existing category
        let category = await prisma.category.findUnique({
          where: { name: categoryName },
        });

        if (!category) {
          // Create new category
          category = await prisma.category.create({
            data: { name: categoryName },
          });
          summary.categoriesCreated++;
        } else {
          summary.categoriesReused++;
        }
        categoryId = category.id;
      }

      // Check if product with the same name already exists for this company
      const existingProduct = await prisma.product.findFirst({
        where: {
          name: prodData.name.trim(),
          companyId: companyId,
        },
      });

      const productPayload = {
        name: prodData.name.trim(),
        productCode: prodData.productCode || null,
        description: prodData.description || null,
        indications: prodData.indications || null,
        targetSpecies: prodData.targetSpecies || [],
        physicalForm: prodData.physicalForm || null,
        appearance: prodData.appearance || null,
        activeIngredients: prodData.activeIngredients || null,
        dosage: prodData.dosage || null,
        mixingInstructions: prodData.mixingInstructions || null,
        withdrawalPeriod: prodData.withdrawalPeriod || null,
        contraindications: prodData.contraindications || null,
        userSafety: prodData.userSafety || [],
        storage: prodData.storage || null,
        packaging: prodData.packaging || null,
        registrationNumber: prodData.registrationNumber || null,
        origin: prodData.origin || null,
        producer: prodData.producer || null,
        specifications: prodData.specifications || null,
        categoryId: categoryId,
        companyId: companyId,
      };

      let product;
      if (existingProduct) {
        // Update product to update specs
        product = await prisma.product.update({
          where: { id: existingProduct.id },
          data: productPayload,
        });
        summary.productsUpdated++;
      } else {
        // Create product
        product = await prisma.product.create({
          data: productPayload,
        });
        summary.productsCreated++;
      }

      summary.products.push({
        id: product.id,
        name: product.name,
        category: categoryName,
        action: existingProduct ? "updated" : "created"
      });
    }
  } catch (error) {
    throw new AppError(`Failed to process and extract PDF catalog: ${error.message}`, 500);
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

  return summary;
};
