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
      You are an expert front-end developer and pixel-perfect design integrator.
      I need you to convert the text layout of the attached document into an extremely precise HTML snippet.

      The document canvas is exactly 1000px wide and 1414px high.
      Your ONLY job is to position text accurately on this canvas. Do NOT recreate the background graphics or borders.

      STRICT REQUIREMENTS:
      1. CONTAINER: Use exactly <div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px; overflow: hidden; box-sizing: border-box;">. Do not include <html> or <body> tags.
      2. ABSOLUTE POSITIONING: Every single piece of text MUST use \`position: absolute\` with exact \`top\` and \`left\` pixel values relative to the 1000x1414 canvas. Do not use generic margins.
      3. CENTERING: If a text block is horizontally centered on the document, use \`left: 0; width: 100%; text-align: center;\` along with the exact \`top\` position.
      4. TEXT FORMATTING: Accurately estimate and apply inline CSS for \`font-size\` (in px), \`color\` (exact HEX code), \`font-weight\`, \`font-family\`, \`letter-spacing\`, and \`line-height\`.
      5. VARIABLES: Replace dynamic data (names, dates, scores, batch numbers) with Handlebars variables (e.g., {{student_name}}, {{issue_date}}, {{product}}).
      6. TABLES / GRIDS: If there is a table or a grid of text, you can use a \`<table>\` positioned absolutely, or position each line absolutely. Ensure columns align perfectly.
      7. OUTPUT FORMAT: Output ONLY the raw, pure HTML string. No markdown formatting, no \`\`\`html blocks, no explanations.
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
