import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import AppError from "../utils/appError.js";

export const generateHtmlFromDesign = async (filePath, fileName, mimeType) => {
  if (!process.env.GEMINI_API_KEY && process.env.MOCK_GEMINI !== "true") {
    throw new AppError("Gemini API key is not configured on the server!", 500);
  }

  // Mock handling
  if (process.env.MOCK_GEMINI === "true" || !process.env.GEMINI_API_KEY) {
     return `<div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px; border: 1px solid #ccc; padding: 50px;">
        <h1 style="text-align: center; color: #333;">Certificate of Analysis</h1>
        <div style="position: absolute; top: 200px; left: 100px;">Product: {{product_name}}</div>
        <div style="position: absolute; top: 250px; left: 100px;">Batch: {{batch_number}}</div>
        <div style="position: absolute; top: 300px; left: 100px;">Date: {{date}}</div>
     </div>`;
  }

  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  let uploadResult = null;
  let tempPdfPath = null;
  try {
    const isAiFile = fileName.toLowerCase().endsWith('.ai');
    const uploadMimeType = isAiFile ? 'application/pdf' : mimeType;
    
    let uploadPath = filePath;
    if (isAiFile) {
      tempPdfPath = `${filePath}.pdf`;
      fs.copyFileSync(filePath, tempPdfPath);
      uploadPath = tempPdfPath;
    }

    console.log(`[AITemplateService] Uploading file to Gemini (MimeType: ${uploadMimeType})...`);
    uploadResult = await fileManager.uploadFile(uploadPath, {
      mimeType: uploadMimeType,
      displayName: fileName,
    });

    let file = await fileManager.getFile(uploadResult.file.name);
    let attempts = 0;
    while (file.state === "PROCESSING" && attempts < 12) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      file = await fileManager.getFile(uploadResult.file.name);
      attempts++;
    }
    if (file.state !== "ACTIVE") {
      throw new AppError(`File processing failed at Gemini API. State: ${file.state}. Make sure the .ai file was saved with 'Create PDF Compatible File' checked.`, 500);
    }

    console.log(`[AITemplateService] Requesting HTML generation from gemini-1.5-pro...`);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro",
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.0,
        responseMimeType: "application/json",
      }
    });

    const promptText = `
      You are a world-class Web-to-Print AI.
      Your task is to identify ONLY the dynamic fill-in values on the provided document and return their exact coordinates and styles as a JSON array.
      
      CRITICAL CONTEXT:
      The document canvas is exactly 1000px wide and 1414px high.
      The background image of the certificate (including ALL static text, field labels, logos, and borders) is ALREADY present.
      
      YOUR EXACT MISSION:
      Find the actual dynamic dummy values (e.g., "DOXYPHARMA", "09/2028", "TURKEY", "1KG", the test results, etc.) and map them to logical variable names.
      DO NOT extract static labels like "PRODUCT NAME", "BATCH NUMBER", "DESCRIPTION", "Company Address". Ignore them completely.

      JSON SCHEMA REQUIRED:
      Return a raw JSON array of objects. Do not include markdown formatting.
      [
        {
          "variable_name": "product_name",
          "top_px": 185,
          "left_px": 170,
          "font_size_px": 12,
          "color_hex": "#000000",
          "font_weight": "normal",
          "text_align": "left",
          "width_px": 200 // optional, use if it needs to be centered within a specific width, otherwise omit
        }
      ]

      RULES:
      1. IGNORE ALL STATIC TEXT. If a text is a label for a field (e.g., "Product:"), do NOT include it. Only include the value next to it.
      2. IGNORE LOGOS & ADDRESSES: Do not include the company name, address block, or fixed footer text.
      3. PERFECT POSITIONING: Estimate the exact \`top\` and \`left\` pixel coordinates on the 1000x1414 canvas.
      4. VARIABLES: Use clear snake_case names for \`variable_name\` (e.g., \`manufacturing_date\`, \`result_1\`, \`batch_no\`).
      5. OUTPUT ONLY JSON. No explanations, no \`\`\`json blocks.
    `;

    const contents = [
      {
        fileData: {
          mimeType: uploadMimeType,
          fileUri: uploadResult.file.uri,
        },
      },
      promptText
    ];

    const response = await model.generateContent(contents);
    let resultText = response.response.text();

    // Clean up markdown if any
    let cleanJson = resultText.trim();
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.substring(7);
    } else if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.substring(3);
    }
    if (cleanJson.endsWith("```")) {
      cleanJson = cleanJson.substring(0, cleanJson.length - 3);
    }

    // Parse JSON and build HTML
    let elements = [];
    try {
      elements = JSON.parse(cleanJson.trim());
    } catch (parseErr) {
      console.error("[AITemplateService] Failed to parse AI JSON:", cleanJson);
      throw new AppError("AI failed to return valid JSON format.", 500);
    }

    let htmlBuilder = `<div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px; overflow: hidden; box-sizing: border-box;">\n`;
    
    for (const el of elements) {
      const widthStyle = el.width_px ? `width: ${el.width_px}px;` : '';
      htmlBuilder += `  <div style="position: absolute; top: ${el.top_px}px; left: ${el.left_px}px; ${widthStyle} font-size: ${el.font_size_px}px; color: ${el.color_hex}; font-weight: ${el.font_weight || 'normal'}; text-align: ${el.text_align || 'left'}; white-space: nowrap;">{{${el.variable_name}}}</div>\n`;
    }
    
    htmlBuilder += `</div>`;

    return htmlBuilder;
  } catch (error) {
    console.error("[AITemplateService] Error:", error);
    throw error;
  } finally {
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try { fs.unlinkSync(tempPdfPath); } catch (e) {}
    }
    if (uploadResult && uploadResult.file) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) {}
    }
  }
};
