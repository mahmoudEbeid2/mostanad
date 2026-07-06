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
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.1,
      }
    });

    const promptText = `
      You are a world-class front-end developer and Pixel-Perfect Design Integrator.
      Your task is to convert the textual content of the attached document into an extremely precise HTML snippet.
      
      CRITICAL CONTEXT:
      The document canvas is exactly 1000px wide and 1414px high.
      The background image, logos, stamps, lines, borders, and table grids are ALREADY HANDLED by the system.
      Your ONLY job is to position the TEXT precisely on this 1000x1414 canvas.

      STRICT RULES:
      1. IGNORE GRAPHICS & LOGOS: Do NOT extract text that is part of a company logo, stamp, or signature image.
      2. CONTAINER: Use exactly: <div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px; overflow: hidden; box-sizing: border-box;">
      3. ABSOLUTE POSITIONING ONLY: Every piece of text MUST be enclosed in a <div> with \`position: absolute\`. Do not group text from different locations. Use exact \`top\` and \`left\` pixel values.
      4. NO HTML TABLES: Do NOT use <table> tags. Since table borders are already in the background, simply position the text of each cell as an independent absolute <div>.
      5. TEXT WRAPPING: Add \`white-space: nowrap;\` to single-line text to prevent them from breaking into two lines.
      6. CENTERING: For text horizontally centered on the page, use: \`left: 0; width: 100%; text-align: center;\` along with the exact \`top\`.
      7. VARIABLES & FILL-IN LINES: Replace dynamic data with Handlebars tags (e.g., {{student_name}}, {{batch_no}}). If there is an underline like "Name: ________", output "Name: {{name}}" and ignore the underline graphic.
      8. NO OVERLAPPING: Double-check your \`top\` values to maintain correct vertical spacing and prevent text from overlapping.
      9. TEXT FORMATTING: Accurately estimate \`font-size\` (in px), \`color\` (exact HEX code), and \`font-weight\`.
      10. OUTPUT FORMAT: Output ONLY raw HTML. No markdown formatting, no \`\`\`html blocks, no explanations.
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
