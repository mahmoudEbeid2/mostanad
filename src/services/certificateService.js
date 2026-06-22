import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

/**
 * Helper to call Gemini model with retry and fallback
 */
async function callGemini(genAI, modelName, fileData, promptText) {
  let resultText = "";
  let success = false;
  let retries = 4;
  let delay = 3000;
  let currentModelName = modelName;

  while (retries > 0 && !success) {
    try {
      console.log(`[CertificateService] Calling generateContent with model ${currentModelName}... (Retries left: ${retries})`);
      const activeModel = genAI.getGenerativeModel({ model: currentModelName });
      
      const contents = [];
      if (fileData) {
        contents.push({
          fileData: {
            mimeType: fileData.mimeType,
            fileUri: fileData.uri,
          },
        });
      }
      contents.push(promptText);

      const response = await activeModel.generateContent(contents);
      resultText = response.response.text();
      success = true;
    } catch (error) {
      console.warn(`[CertificateService] Error during generateContent: ${error.message}`);
      const errMsg = error.message || "";
      const isQuotaOrDemand = 
        errMsg.includes("503") || 
        errMsg.includes("Service Unavailable") || 
        errMsg.includes("429") || 
        errMsg.includes("Too Many Requests") ||
        errMsg.includes("demand") ||
        errMsg.includes("quota");

      if (isQuotaOrDemand && currentModelName === "gemini-2.5-flash") {
        console.warn("[CertificateService] High demand/quota error detected on gemini-2.5-flash. Falling back to gemini-2.0-flash...");
        currentModelName = "gemini-2.0-flash";
        retries--;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else if (isQuotaOrDemand) {
        console.warn(`[CertificateService] Quota/demand error. Retrying model ${currentModelName} in ${delay}ms...`);
        retries--;
        if (retries === 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 1.5;
      } else {
        console.error("[CertificateService] Non-quota error, throwing immediately.");
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
  return cleanJson.trim();
}

/**
 * Extract products from invoice, lookup database, resolve templates, populate fields and HTML using Gemini
 */
export const generateCertificatesAndPopulateTemplates = async (
  companyId,
  brandId,
  transactionType,
  fileBuffer,
  fileName,
  mimeType
) => {
  if (!process.env.GEMINI_API_KEY) {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  // 1. Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new AppError("Target company not found!", 404);
  }

  // 2. Save file locally
  const extension = path.extname(fileName) || (mimeType === "application/pdf" ? ".pdf" : ".png");
  const tempFileName = `temp_invoice_${Date.now()}_${Math.random().toString(36).substring(7)}${extension}`;
  const tempFilePath = path.join(process.cwd(), tempFileName);

  console.log(`[CertificateService] Writing temp file to ${tempFilePath}...`);
  fs.writeFileSync(tempFilePath, fileBuffer);

  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  let uploadResult = null;
  try {
    // 3. Upload file to Gemini File API
    console.log(`[CertificateService] Uploading file to Gemini File API (MimeType: ${mimeType})...`);
    uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: mimeType,
      displayName: fileName,
    });

    // Poll for the file to be processed (state ACTIVE)
    console.log("[CertificateService] Polling file state...");
    let file = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (file.state === "PROCESSING" && attempts < 12) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      file = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }
    if (file.state !== "ACTIVE") {
      throw new AppError(`File processing failed at Gemini API. State: ${file.state}`, 500);
    }

    // 4. STAGE 1: Extract Products from Invoice
    console.log("[CertificateService] Stage 1: Extracting product list from invoice...");
    const stage1Prompt = `
      You are an expert systems integration specialist.
      Analyze the uploaded invoice image or PDF.
      Identify and extract all product items listed in this invoice.
      For each product, extract:
      - name: The product's commercial name.
      - productCode: The product code, catalog number, or registration code if explicitly mentioned (or null if not found).

      Return the results ONLY as a valid JSON object matching the schema below:
      {
        "products": [
          {
            "name": "string",
            "productCode": "string or null"
          }
        ]
      }
      Do not include any chat, markdown formatting, or HTML tags outside the JSON object.
    `;

    const stage1Json = await callGemini(genAI, "gemini-2.5-flash", uploadResult.file, stage1Prompt);
    const stage1Data = JSON.parse(stage1Json);
    const extractedProducts = stage1Data.products || [];
    console.log(`[CertificateService] Extracted ${extractedProducts.length} products from invoice.`);

    // 5. Database lookup for products
    const matchedProducts = [];
    const unmatchedProducts = [];
    const matchedProductDetailsForResponse = [];

    for (const p of extractedProducts) {
      const searchConditions = [
        { name: { equals: p.name.trim(), mode: "insensitive" } }
      ];
      if (p.productCode && p.productCode.trim()) {
        searchConditions.push({ productCode: { equals: p.productCode.trim(), mode: "insensitive" } });
      }

      const dbProduct = await prisma.product.findFirst({
        where: {
          companyId,
          OR: searchConditions
        }
      });

      if (dbProduct) {
        matchedProducts.push(dbProduct);
        matchedProductDetailsForResponse.push({
          id: dbProduct.id,
          name: p.name,
          dbName: dbProduct.name,
          productCode: dbProduct.productCode,
          existsInDb: true
        });
      } else {
        unmatchedProducts.push(p);
        matchedProductDetailsForResponse.push({
          id: null,
          name: p.name,
          dbName: null,
          productCode: p.productCode,
          existsInDb: false
        });
      }
    }

    // 6. Fetch templates for this company and brand
    const templates = await prisma.template.findMany({
      where: {
        companyId,
        OR: [
          { brandId: brandId || null },
          { brandId: null }
        ],
        isActive: true
      }
    });

    if (templates.length === 0) {
      return {
        products: matchedProductDetailsForResponse,
        certificates: []
      };
    }

    const templatesToPopulate = templates.map(t => ({
      templateId: t.id,
      templateName: t.name,
      type: t.type,
      isGlobal: t.isGlobal,
      productId: t.productId,
      requiredFields: t.fields || {}
    }));

    // 7. STAGE 2: Extract & Infer Fields using Product Data and Invoice details
    console.log("[CertificateService] Stage 2: Populating template fields using Gemini...");
    const stage2Prompt = `
      You are an expert systems integration and document population specialist.
      Analyze the uploaded invoice, the provided matched products database records, the unmatched products list, and the list of requested document templates.

      Matched Products Catalog Data (from Database):
      ${JSON.stringify(matchedProducts)}

      Unmatched Products (from Invoice only):
      ${JSON.stringify(unmatchedProducts)}

      Requested Templates to populate:
      ${JSON.stringify(templatesToPopulate)}

      Transaction Type context: "${transactionType}"

      Instructions:
      1. For each template requested:
         a. If it is global (isGlobal = true), populate its requiredFields ONCE using the invoice context.
         b. If it is product-scoped (isGlobal = false):
            - If it specifies a template-level productId, only populate it if that product is present in the invoice (matched or unmatched).
            - If it does not specify a template-level productId, populate a separate set of requiredFields for EACH of the products (both matched and unmatched) listed in the invoice.
         c. For each field, you MUST map it using the following priority:
            - Priority 1: Extract it from the invoice text.
            - Priority 2: Extract it from the matched product database details (e.g. active ingredients, category, storage, dosage, physicalForm, mixingInstructions, contraindications).
            - Priority 3: If not found in invoice or database record, use your industry/domain knowledge as an expert AI to infer, estimate, and generate a highly accurate, professional value appropriate for this product. Do not return empty or null values if you can logically generate/estimate them.

      Return the results ONLY as a valid JSON object matching the schema below:
      {
        "populatedTemplates": [
          {
            "templateId": "string",
            "productId": "string or null (the specific database product ID or product name if unmatched, or null if the template is global)",
            "filledFields": {
              "fieldName": "inferred or extracted value"
            }
          }
        ]
      }
      Do not include any chat, markdown code blocks, or extra text.
    `;

    const stage2Json = await callGemini(genAI, "gemini-2.5-flash", uploadResult.file, stage2Prompt);
    const stage2Data = JSON.parse(stage2Json);
    const populatedTemplates = stage2Data.populatedTemplates || [];

    // 8. Replace placeholders in HTML content
    const certificates = [];
    for (const filled of populatedTemplates) {
      const template = templates.find(t => t.id === filled.templateId);
      if (!template) continue;

      let populatedHtml = template.htmlContent;
      const fields = filled.filledFields || {};
      for (const [key, value] of Object.entries(fields)) {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
        populatedHtml = populatedHtml.replace(regex, value !== null && value !== undefined ? String(value) : "");
      }

      certificates.push({
        templateId: template.id,
        templateName: template.name,
        type: template.type,
        isGlobal: template.isGlobal,
        productId: filled.productId,
        filledFields: fields,
        html: populatedHtml
      });
    }

    return {
      products: matchedProductDetailsForResponse,
      certificates
    };

  } finally {
    // 9. Clean up files
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (_) {}
    }
    if (uploadResult && uploadResult.file) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }
};
