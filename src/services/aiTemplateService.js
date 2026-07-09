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
      You are an expert front-end developer and designer. 
      Analyze the attached document (invoice, certificate, or form) design. 
      I need you to convert this entire design into a clean, precise, and responsive HTML snippet using inline CSS.
      Requirements:
      - Fully reconstruct the design natively using HTML elements (tables, divs, flexbox, borders, colors, paddings).
      - Recreate ALL text, labels, headers, and values EXACTLY as they appear in the original document.
      - DO NOT use any Handlebars variables (like {{name}}). Output the exact original text you see.
      - DO NOT assume there is a background image. You must recreate tables with visible borders, colored headers, and proper padding.
      - Any logos or images present in the document MUST be extracted and embedded directly as Base64 strings using <img src="data:image/png;base64,...">. Do not use external image URLs.
      - The output should ONLY contain valid HTML code. Do NOT output markdown code blocks (\`\`\`html). Output the raw HTML directly.
      - Do NOT wrap it in <html><body> tags, just return the main wrapper <div>.
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
        console.log(`[AITemplateService] Requesting HTML generation from gemini-3.5-flash (Attempt ${i + 1})...`);
        const currentModel = genAI.getGenerativeModel({
          model: "gemini-3.5-flash",
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.0,
            responseMimeType: "application/json",
            responseSchema: {
               type: "object",
               properties: {
                  html: {
                     type: "string",
                     description: "The complete, raw, native HTML code containing the entire reconstructed document layout, tables, and Base64 images. Do NOT include markdown formatting or explanations."
                  }
               },
               required: ["html"]
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
    let parsedResult;
    try {
      parsedResult = JSON.parse(resultText);
    } catch (e) {
      console.warn("[AITemplateService] Failed to parse JSON, falling back to raw text.");
      parsedResult = { html: resultText };
    }

    let cleanHtml = parsedResult.html.trim();
    if (cleanHtml.startsWith("\`\`\`html")) {
      cleanHtml = cleanHtml.substring(7);
    } else if (cleanHtml.startsWith("\`\`\`")) {
      cleanHtml = cleanHtml.substring(3);
    }
    if (cleanHtml.endsWith("\`\`\`")) {
      cleanHtml = cleanHtml.substring(0, cleanHtml.length - 3);
    }

    console.log(`[AITemplateService] Successfully generated HTML.`);
    return cleanHtml.trim();
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
