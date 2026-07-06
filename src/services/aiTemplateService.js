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
      }
    });

    const promptText = `
      You are a world-class front-end developer and Pixel-Perfect Design Integrator.
      Your task is to create the dynamic overlay for a Web-to-Print template.
      
      CRITICAL CONTEXT:
      The document canvas is exactly 1000px wide and 1414px high.
      The background image of the certificate (including ALL static text, logos, lines, and table headers) is ALREADY in the background layer.
      
      YOUR EXACT MISSION:
      You must ONLY extract the DYNAMIC/FILL-IN values (the dummy data in the document) and convert them to Handlebars variables enclosed in absolute positioned <div>s.

      STRICT RULES:
      1. IGNORE ALL STATIC TEXT: Do NOT output <div>s for static labels like "PRODUCT NAME", "BATCH NUMBER", "DESCRIPTION", "EXPORTER COMPANY", etc. The background already has them!
      2. IGNORE LOGOS: Do NOT output the company name or logo text (e.g., "Pharmavet ANIMAL HEALTH").
      3. ONLY DYNAMIC VALUES: Find the actual dummy values (e.g., "DOXYPHARMA", "09/2028", "TURKEY", "1KG") and output them as Handlebars variables (e.g., {{product_name}}, {{expiration_date}}, {{origin}}).
      4. PERFECT POSITIONING: For the dynamic values you extract, estimate their exact \`top\` and \`left\` pixel coordinates on the 1000x1414 canvas and position them using \`position: absolute\`.
      5. TEXT FORMATTING: Accurately estimate the \`font-size\` (px), \`color\`, and \`font-weight\` of the dynamic value.
      6. OUTPUT FORMAT: Output ONLY raw HTML. No markdown formatting, no \`\`\`html blocks, no explanations. 
      
      If you output static labels, they will double-render and ruin the design! ONLY output the dynamic variables.
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
