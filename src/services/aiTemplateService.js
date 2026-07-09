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
You are a Senior Frontend Engineer, Adobe Illustrator Expert, OCR Specialist, and HTML/CSS Layout Reconstruction Engine.

Your task is to convert the uploaded Adobe Illustrator (.ai) or PDF design into a production-ready HTML template.

The generated result must be visually as close as possible to the original design.

=========================
GENERAL REQUIREMENTS
=========================

- Return ONLY valid JSON.
- Do NOT use Markdown.
- Do NOT explain anything.
- Do NOT omit any visible element.
- The generated HTML must reproduce the original design with pixel-level accuracy.

=========================
HTML REQUIREMENTS
=========================

Generate semantic HTML whenever possible.

Use:
- div
- table
- thead
- tbody
- tr
- td
- span
- p
- img
- h1-h6

Never use canvas.
Never use SVG unless the original design contains SVG graphics that cannot be recreated with HTML.

Preserve:
- layout
- spacing
- alignment
- margins
- paddings
- borders
- border radius
- shadows
- colors
- line height
- text alignment
- font sizes
- font weights
- opacity
- rotations (if needed)

=========================
CSS REQUIREMENTS
=========================

Generate clean CSS.
Avoid unnecessary inline styles.
Use classes instead of IDs whenever possible.
Absolute positioning is allowed only when necessary to preserve the layout.
The final design should look identical to the original.

=========================
TABLE DETECTION
=========================

If a table exists:
Generate a real HTML table.

Use:
<table>
<thead>
<tbody>
<tr>
<td>

Do NOT recreate tables using divs.
Preserve:
- merged cells
- row spans
- column spans
- borders
- alignment
- widths
- heights

=========================
TEXT DETECTION
=========================

Extract every visible text.
Preserve:
- capitalization
- punctuation
- spacing
- font size
- font weight
- alignment
- color

=========================
DYNAMIC FIELD DETECTION
=========================

Identify values that are likely to change between generated certificates.
Replace them with placeholders.

Examples:
Company Name → {{company_name}}
Batch Number → {{batch_number}}
Expiry Date → {{expiry_date}}
Manufacturing Date → {{manufacturing_date}}
Country → {{country}}
Weight → {{weight}}
Result → {{result}}
Customer → {{customer}}
Certificate Number → {{certificate_number}}
Date → {{date}}

Do NOT replace static labels.
Example:
Batch No: {{batch_number}} (NOT {{Batch No}})

=========================
IMAGE HANDLING
=========================

Every detected image must become an img tag.
Example: <img src="{{image_1}}" class="logo"/>
Do NOT convert images into Base64.
Do NOT redraw logos.
Do NOT recreate photos using HTML.
Use placeholders: {{logo}}, {{image_1}}, {{image_2}}...

=========================
BACKGROUND
=========================

Preserve:
- background color
- background images
- gradients
- decorative elements

=========================
FONTS
=========================

If the exact font can be identified: Use it.
Otherwise use the closest web-safe font.
Preserve: font-size, font-weight, letter-spacing, line-height

=========================
OUTPUT FORMAT
=========================

Return ONLY
{
  "html":"...",
  "css":"..."
}
No additional keys. No explanation. No markdown.

=========================
IMPORTANT
=========================
Accuracy is more important than simplicity.
Do not simplify the layout.
Do not redesign the document.
Reconstruct the document exactly as it appears.
The generated HTML should produce a visual result that is at least 98% identical to the uploaded design.
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
        const modelName = i === 0 ? "gemini-2.5-pro" : "gemini-3.5-flash";
        console.log(`[AITemplateService] Requesting JSON output from ${modelName} (Attempt ${i + 1})...`);
        const currentModel = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            maxOutputTokens: 65536,
            temperature: 0.0,
            responseMimeType: "application/json",
            responseSchema: {
               type: "object",
               properties: {
                 html: { type: "string" },
                 css: { type: "string" }
               },
               required: ["html", "css"]
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

    console.log(`[AITemplateService] Successfully generated JSON object.`);
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
