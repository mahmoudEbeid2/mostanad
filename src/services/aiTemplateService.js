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
  let svgContent = null;
  try {
    const isSvg = fileName.toLowerCase().endsWith('.svg');

    if (isSvg) {
      console.log(`[AITemplateService] Reading SVG file directly as text...`);
      svgContent = fs.readFileSync(filePath, 'utf-8');
    } else {
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
    }

    const promptText = `
      You are an expert OCR Layout Extraction Engine specialized in scanned certificates and forms.
      Your ONLY task is to detect the dynamic text values that should later be editable.
      
      Extract ONLY editable values.
      Examples:
      "DOXYPHARMA"
      "09/2028"
      "TURKEY"
      "1 KG"
      "Conforms"

      Never extract static headers, labels, table borders, logos, or specifications.
      
      Return ONLY a JSON array of strings representing the exact original text.
      Example Output:
      [
        "DOXYPHARMA",
        "09/2028",
        "TURKEY"
      ]

      No markdown. No explanation. Only valid JSON.
    `;

    let contents = [];
    if (isSvg) {
      contents = [
        "Here is the raw SVG code of the design:\n" + svgContent,
        promptText
      ];
    } else {
      contents = [
        {
          fileData: {
            mimeType: uploadResult.file.mimeType,
            fileUri: uploadResult.file.uri,
          },
        },
        promptText
      ];
    }

    let response;
    let retries = 5;
    for (let i = 0; i < retries; i++) {
      try {
        const modelName = i < 2 ? "gemini-3.5-flash" : "gemini-1.5-flash";
        console.log(`[AITemplateService] Requesting JSON array from ${modelName} (Attempt ${i + 1})...`);
        const currentModel = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.0,
            responseMimeType: "application/json",
            responseSchema: {
               type: "array",
               items: {
                 type: "string",
               },
               description: "An array of the exact text values found in the document that are considered dynamic/fill-in variables."
            }
          }
        });

        response = await currentModel.generateContent(contents);
        break; // Success
      } catch (err) {
        console.warn(`[AITemplateService] Attempt ${i + 1} failed: ${err.message}`);
        if (i === retries - 1) throw err;
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }

    let resultText = response.response.text();
    let cleanJson = resultText.trim();
    if (cleanJson.startsWith("\`\`\`json")) {
      cleanJson = cleanJson.substring(7);
    } else if (cleanJson.startsWith("\`\`\`")) {
      cleanJson = cleanJson.substring(3);
    }
    if (cleanJson.endsWith("\`\`\`")) {
      cleanJson = cleanJson.substring(0, cleanJson.length - 3);
    }

    console.log(`[AITemplateService] Successfully generated JSON array.`);
    return cleanJson.trim();
  } catch (error) {
    console.error("[AITemplateService] Error:", error);
    throw error;
  } finally {
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try { fs.unlinkSync(tempPdfPath); } catch (e) { }
    }
    if (uploadResult && uploadResult.file) {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (_) { }
    }
  }
};
