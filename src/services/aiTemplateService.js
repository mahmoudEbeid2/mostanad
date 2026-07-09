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

    // Model instantiation moved inside the retry loop for fallback handling

    const promptText = `
      You are a world-class Web-to-Print AI.
      Your task is to identify ONLY the dynamic fill-in values on the provided document and return their exact coordinates and styles as a JSON array.
      
      CRITICAL CONTEXT:
      The document canvas is exactly 1000px wide and 1414px high.
      The background image of the certificate (including ALL static text, field labels, logos, and borders) is ALREADY present.
      
      YOUR EXACT MISSION:
      Find the actual text values (the dummy data, e.g., "DOXYPHARMA", "09/2028", "TURKEY", "1KG", the test results like "Conforms", etc.) and return their exact bounding boxes and styles as a JSON array.
      DO NOT convert them into variables. Return the exact original text.
      DO NOT extract static labels like "PRODUCT NAME", "BATCH NUMBER", "DESCRIPTION", "Company Address". Ignore them completely.

      JSON SCHEMA REQUIRED:
      Return a raw JSON array of objects. Do not include markdown formatting.
      [
        {
          "original_text": "DOXYPHARMA",
          "box_2d": [ymin, xmin, ymax, xmax], // INT from 0 to 1000
          "font_size_px": 12,
          "color_hex": "#000000",
          "font_weight": "normal",
          "text_align": "left",
          "width_px": 200 // optional
        }
      ]

      RULES:
      1. IGNORE ALL STATIC TEXT. If a text is a label for a field (e.g., 'Product:'), do NOT include it. Only include the value next to it.
      2. IGNORE LOGOS, ADDRESSES & BANK DETAILS: Do NOT extract company names, buyer/seller addresses, contact info, or bank account details. These are usually static elements in invoices.
      3. ONLY EXTRACT TRANSACTION DATA: We only care about products, quantities, prices, totals, test results, etc.
      4. IGNORE SPECIFICATIONS: In testing tables, DO NOT extract the 'Specifications', 'Limits', or 'Description' columns. ONLY extract the 'RESULTS' column values.
      5. PERFECT POSITIONING: Provide the exact 2D bounding box [ymin, xmin, ymax, xmax] for each text. The coordinates MUST be normalized integers between 0 and 1000.
      6. ORIGINAL TEXT: Output the exact original text. Do NOT use brackets or variables.
      7. OUTPUT ONLY JSON. No explanations. No markdown blocks.
    `;

    const extractSection = async (sectionPrompt, sectionName) => {
      const contents = [
        {
          fileData: {
            mimeType: uploadMimeType,
            fileUri: uploadResult.file.uri,
          },
        },
        sectionPrompt
      ];

      let finalParsedJson = null;
      let retries = 5;
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`[AITemplateService] Requesting HTML generation for ${sectionName} from gemini-3.5-flash (Attempt ${i + 1})...`);
          const currentModel = genAI.getGenerativeModel({
            model: "gemini-3.5-flash",
            generationConfig: {
              maxOutputTokens: 8192,
              temperature: 0.0,
              responseMimeType: "application/json",
            }
          });

          const generatePromise = currentModel.generateContent(contents);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out after 60 seconds')), 60000)
          );

          let response = await Promise.race([generatePromise, timeoutPromise]);
          let resultText = response.response.text();
          let cleanJson = resultText.trim();
          if (cleanJson.startsWith("```json")) {
            cleanJson = cleanJson.substring(7);
          } else if (cleanJson.startsWith("```")) {
            cleanJson = cleanJson.substring(3);
          }
          if (cleanJson.endsWith("```")) {
            cleanJson = cleanJson.substring(0, cleanJson.length - 3);
          }

          console.log(`[AITemplateService] AI JSON Output for ${sectionName}:`, cleanJson.trim());
          finalParsedJson = JSON.parse(cleanJson.trim());
          break; // Success
        } catch (err) {
          console.warn(`[AITemplateService] Attempt ${i + 1} for ${sectionName} failed: ${err.message}`);
          if (i === retries - 1) {
            console.error(`[AITemplateService] All ${retries} attempts failed for ${sectionName}. Last error: ${err.message}`);
            throw new AppError("The AI service is currently experiencing high demand or returning invalid data. Please try again later.", 503);
          }
          // Exponential backoff (2s, 4s, 8s, 16s, 32s)
          await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, i)));
        }
      }

      return finalParsedJson;
    };

    const topPrompt = promptText + "\n\nCRITICAL INSTRUCTION: ONLY extract text located strictly in the top 500 units of the page (where ymin is between 0 and 500). DO NOT extract anything below 500. DO NOT duplicate any data.";
    const bottomPrompt = promptText + "\n\nCRITICAL INSTRUCTION: ONLY extract text located strictly in the bottom 500 units of the page (where ymin is STRICTLY GREATER THAN 500). DO NOT extract anything above 500. DO NOT duplicate any data.";

    console.log("[AITemplateService] Starting two-part extraction...");
    const topElements = await extractSection(topPrompt, "Top Half");
    const bottomElements = await extractSection(bottomPrompt, "Bottom Half");

    const allElements = [...topElements, ...bottomElements];
    
    // Deduplicate elements to prevent repeating text on top of each other
    const elements = [];
    for (const el of allElements) {
      const isDuplicate = elements.some(existing => {
         const existingText = existing.original_text || existing.text || existing.value || "";
         const currentText = el.original_text || el.text || el.value || "";
         const existingY = existing.box_2d ? existing.box_2d[0] : (existing.top_px || 0);
         const currentY = el.box_2d ? el.box_2d[0] : (el.top_px || 0);
         // Increase overlap threshold to 45px to aggressively remove duplicates
         return existingText === currentText && Math.abs(existingY - currentY) < 45;
      });
      if (!isDuplicate) {
        elements.push(el);
      }
    }

    let htmlBuilder = `<div class="certificate-wrapper" style="position: relative; width: 1000px; height: 1414px; overflow: hidden; box-sizing: border-box;">\n`;

    for (const el of elements) {
      let top = 0;
      let left = 0;

      if (el.box_2d && Array.isArray(el.box_2d) && el.box_2d.length === 4) {
        // box_2d is [ymin, xmin, ymax, xmax] mapped to 0-1000
        const ymin = el.box_2d[0];
        const xmin = el.box_2d[1];
        top = Math.round((ymin / 1000) * 1414);
        left = Math.round((xmin / 1000) * 1000);
      } else {
        // Fallback if AI didn't follow instruction
        top = el.top_px !== undefined ? el.top_px : (el.top !== undefined ? el.top : 0);
        left = el.left_px !== undefined ? el.left_px : (el.left !== undefined ? el.left : 0);
      }
      const fontSize = el.font_size_px !== undefined ? el.font_size_px : (el.font_size !== undefined ? el.font_size : 12);
      const color = el.color_hex || el.color || '#000000';
      const width = el.width_px !== undefined ? el.width_px : el.width;
      const widthStyle = width ? `width: ${width}px;` : '';

      const textToDisplay = el.original_text || el.text || el.value || "Text";

      htmlBuilder += `  <div style="position: absolute; top: ${top}px; left: ${left}px; ${widthStyle} font-size: ${fontSize}px; color: ${color}; background-color: #ffffff; font-weight: ${el.font_weight || 'normal'}; text-align: ${el.text_align || 'left'}; white-space: nowrap; padding: 0 2px;">${textToDisplay}</div>\n`;
    }

    htmlBuilder += `</div>`;

    return htmlBuilder;
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
