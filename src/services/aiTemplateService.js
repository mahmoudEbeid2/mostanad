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
You are an expert OCR Layout Extraction Engine specialized in Adobe Illustrator, PDF and scanned certificates.

Your ONLY task is to detect the dynamic values that should later be editable.

The certificate background already exists.
Do NOT recreate any background.
Do NOT recreate labels.
Do NOT recreate borders.
Do NOT recreate logos.
Do NOT recreate tables.

-------------------------------------------------
CANVAS
-------------------------------------------------

Canvas Width: 1000 px
Canvas Height: 1414 px

Return coordinates in IMAGE PIXELS.

box_2d format:

[ymin, xmin, ymax, xmax]

where

xmin ∈ [0,1000]
xmax ∈ [0,1000]

ymin ∈ [0,1414]
ymax ∈ [0,1414]

Coordinates MUST be integers.

-------------------------------------------------
EXTRACT ONLY
-------------------------------------------------

Extract ONLY editable values.

Examples:

✓ DOXYPHARMA
✓ 09/2028
✓ TURKEY
✓ 1 KG
✓ Conforms
✓ Positive
✓ 2.6
✓ 500 mg
✓ 99.01%
✓ 702.06%

Never extract:

✗ PRODUCT NAME
✗ EXPIRATION DATE
✗ CATEGORY
✗ STORAGE CONDITIONS
✗ DESCRIPTION
✗ SPECIFICATIONS
✗ RESULTS
✗ COMPANY ADDRESS
✗ LOGOS
✗ WATERMARK
✗ FOOTER
✗ HEADER
✗ QR CODE
✗ STAMPS
✗ SIGNATURES
✗ CERTIFICATE OF ANALYSIS
✗ Fixed text

-------------------------------------------------
IMPORTANT FILTERS
-------------------------------------------------

Ignore:

• duplicated OCR
• duplicated layers
• hidden text
• invisible objects
• clipping masks
• outlined text duplicates
• watermark text
• guide layers
• crop marks
• trim marks
• bleed marks

If exactly the same text is detected twice,
KEEP ONLY ONE.

If two OCR boxes overlap more than 70%,
KEEP ONLY THE BEST MATCH.

Never output duplicate objects.

Never output overlapping text.

-------------------------------------------------
STYLE
-------------------------------------------------

Estimate

font_size_px

font_weight

color_hex

text_align

width_px

height_px

Only if clearly visible.

-------------------------------------------------
OUTPUT
-------------------------------------------------

Return ONLY a JSON array.

Example:

[
  {
    "original_text":"DOXYPHARMA",
    "box_2d":[124,150,142,330],
    "font_size_px":12,
    "font_weight":"bold",
    "color_hex":"#222222",
    "text_align":"left",
    "width_px":180,
    "height_px":18
  }
]

No markdown.

No explanation.

No comments.

No code fences.

Only valid JSON.
`;

    const extractSection = async (sectionPrompt, sectionName) => {
      let contents = [];
      if (isSvg) {
        contents = [
          "Here is the raw SVG code of the design:\n" + svgContent,
          sectionPrompt
        ];
      } else {
        contents = [
          {
            fileData: {
              mimeType: uploadResult.file.mimeType,
              fileUri: uploadResult.file.uri,
            },
          },
          sectionPrompt
        ];
      }

      let response;
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

          response = await currentModel.generateContent(contents);
          break; // Success
        } catch (err) {
          console.warn(`[AITemplateService] Attempt ${i + 1} for ${sectionName} failed: ${err.message}`);
          if (i === retries - 1) throw err;
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
      }

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

      try {
        console.log(`[AITemplateService] AI JSON Output for ${sectionName}:`, cleanJson.trim());
        return JSON.parse(cleanJson.trim());
      } catch (parseErr) {
        console.error(`[AITemplateService] Failed to parse AI JSON for ${sectionName}:`, cleanJson);
        throw new AppError("AI failed to return valid JSON format.", 500);
      }
    };

    const topPrompt = promptText + "\n\nCRITICAL INSTRUCTION: ONLY extract text located in the TOP HALF of the page (where ymin is between 0 and 500). DO NOT extract anything from the bottom half.";
    const bottomPrompt = promptText + "\n\nCRITICAL INSTRUCTION: ONLY extract text located in the BOTTOM HALF of the page (where ymin is between 500 and 1000). DO NOT extract anything from the top half.";

    console.log("[AITemplateService] Starting two-part extraction...");
    const topElements = await extractSection(topPrompt, "Top Half");
    const bottomElements = await extractSection(bottomPrompt, "Bottom Half");

    const elements = [...topElements, ...bottomElements];

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

      htmlBuilder += `  <div style="position: absolute; top: ${top}px; left: ${left}px; ${widthStyle} font-size: ${fontSize}px; color: ${color}; background-color: transparent; font-weight: ${el.font_weight || 'normal'}; text-align: ${el.text_align || 'left'}; white-space: nowrap; padding: 0 2px;">${textToDisplay}</div>\n`;
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
