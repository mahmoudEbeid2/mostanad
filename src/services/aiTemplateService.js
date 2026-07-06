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

    console.log(`[AITemplateService] Requesting HTML generation from gemini-2.5-flash...`);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const promptText = `
      You are an expert front-end developer and designer. 
      Analyze the attached certificate/document design. 
      I need you to convert this design into a clean, precise, and responsive HTML snippet using inline CSS.
      Requirements:
      - Use absolute positioning (position: absolute) within a relative wrapper (width: 1000px; height: 1414px) to place text and elements exactly where they appear.
      - Extract all static text and preserve formatting (font size, weight, color).
      - Identify any dynamic text (like names, dates, product names, batch numbers) and replace them with Handlebars-style variables like {{product_name}}, {{date}}, etc.
      - Do NOT extract or recreate the complex background graphics using CSS. Only position the text layers on a transparent background, because the original image will be used as the background behind your HTML.
      - The output should ONLY contain valid HTML code. Do NOT output markdown code blocks (\`\`\`html). Output the raw HTML directly.
      - Do NOT wrap it in <html><body> tags, just a <div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px;"> wrapper.
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

    // Clean up markdown
    let cleanHtml = resultText.trim();
    if (cleanHtml.startsWith("\`\`\`html")) {
      cleanHtml = cleanHtml.substring(7);
    } else if (cleanHtml.startsWith("\`\`\`")) {
      cleanHtml = cleanHtml.substring(3);
    }
    if (cleanHtml.endsWith("\`\`\`")) {
      cleanHtml = cleanHtml.substring(0, cleanHtml.length - 3);
    }

    return cleanHtml.trim();
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
