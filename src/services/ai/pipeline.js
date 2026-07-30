import fs from 'fs';
import path from 'path';
import geminiClient from './geminiClient.js';
import puppeteerService from '../render/puppeteerService.js';
import { 
  layoutPrompt, 
  ocrPrompt, 
  tablePrompt, 
  placeholderPrompt, 
  generationPrompt, 
  criticPrompt 
} from './prompts.js';

function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
      mimeType
    },
  };
}

class AITemplatePipeline {
  
  async runPipeline(pngFilePath) {
    console.log("[AITemplatePipeline] Starting multi-stage reconstruction pipeline...");
    const imagePart = fileToGenerativePart(pngFilePath, "image/png");
    
    console.log("[AITemplatePipeline] Stage 2: Layout Analysis...");
    const layoutAnalysis = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [imagePart, layoutPrompt],
      schema: {
        type: "object",
        properties: {
          layout_description: { type: "string" },
          background_color: { type: "string" },
          major_regions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                description: { type: "string" }
              }
            }
          }
        }
      }
    });

    console.log("[AITemplatePipeline] Stage 3: OCR Extraction...");
    const ocrAnalysis = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [imagePart, ocrPrompt],
      schema: {
        type: "object",
        properties: {
          text_blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                font_size_relative: { type: "string" },
                font_weight: { type: "string" },
                color: { type: "string" },
                alignment: { type: "string" }
              }
            }
          }
        }
      }
    });

    console.log("[AITemplatePipeline] Stage 4: Table Detection...");
    const tableAnalysis = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [imagePart, tablePrompt],
      schema: {
        type: "object",
        properties: {
          table_html: { type: "string" }
        }
      }
    });

    console.log("[AITemplatePipeline] Stage 5: Dynamic Placeholder Detection...");
    const placeholderAnalysis = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [JSON.stringify(ocrAnalysis?.text_blocks || []), placeholderPrompt],
      schema: {
        type: "object",
        properties: {
          dynamic_mappings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                original_text: { type: "string" },
                placeholder: { type: "string" }
              }
            }
          }
        }
      }
    });

    console.log("[AITemplatePipeline] Stage 6: Draft Generation...");
    let generationContext = `
      LAYOUT INFO:
      ${JSON.stringify(layoutAnalysis)}
      
      OCR TEXT:
      ${JSON.stringify(ocrAnalysis)}
      
      TABLES FOUND:
      ${tableAnalysis?.table_html || 'None'}
      
      DYNAMIC PLACEHOLDERS TO INJECT:
      ${JSON.stringify(placeholderAnalysis?.dynamic_mappings || [])}
    `;

    let draft = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [imagePart, generationContext, generationPrompt],
      schema: {
        type: "object",
        properties: {
          html: { type: "string" },
          css: { type: "string" }
        },
        required: ["html", "css"]
      },
      maxOutputTokens: 65536
    });

    let extractedFields = {};
    if (placeholderAnalysis?.dynamic_mappings) {
      placeholderAnalysis.dynamic_mappings.forEach(mapping => {
        extractedFields[mapping.placeholder] = "string";
      });
    }

    const MAX_RETRIES = 2;
    let currentSimilarity = 0;
    
    for (let i = 0; i < MAX_RETRIES; i++) {
      console.log(`[AITemplatePipeline] Stage 7/8: Visual Critic Loop (Iteration ${i + 1})...`);
      
      const draftHtmlDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;background:${layoutAnalysis?.background_color || '#fff'};display:flex;justify-content:center;}${draft.css}</style></head><body>${draft.html}</body></html>`;
      const draftPngPath = pngFilePath.replace('.png', `_draft_${i}.png`);
      
      await puppeteerService.renderHtmlToPng(draftHtmlDoc, draftPngPath);
      const draftImagePart = fileToGenerativePart(draftPngPath, "image/png");

      const criticAnalysis = await geminiClient.generateJson({
        model: "gemini-2.5-flash",
        contents: [
           "ORIGINAL DESIGN:", imagePart, 
           "CURRENT RENDER:", draftImagePart, 
           "CURRENT HTML:", draft.html, 
           "CURRENT CSS:", draft.css, 
           criticPrompt
        ],
        schema: {
          type: "object",
          properties: {
            similarity_score: { type: "number" },
            issues: { type: "array", items: { type: "string" } },
            fixed_html: { type: "string" },
            fixed_css: { type: "string" }
          },
          required: ["similarity_score", "fixed_html", "fixed_css"]
        },
        maxOutputTokens: 65536
      });

      console.log(`[AITemplatePipeline] Critic Score: ${criticAnalysis.similarity_score}%`);
      currentSimilarity = criticAnalysis.similarity_score;
      
      if (criticAnalysis.issues && criticAnalysis.issues.length > 0) {
         console.log(`[AITemplatePipeline] Critic identified issues:`, criticAnalysis.issues);
      }

      draft = {
        html: criticAnalysis.fixed_html,
        css: criticAnalysis.fixed_css
      };

      if (currentSimilarity >= 98) {
        console.log("[AITemplatePipeline] Target similarity reached. Stopping correction loop.");
        break;
      }
    }

    const finalHtmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; display: flex; justify-content: center; background: ${layoutAnalysis?.background_color || '#fff'}; }
  ${draft.css}
</style>
</head>
<body>
${draft.html}
</body>
</html>`;

    return {
      finalHtml: finalHtmlDoc,
      extractedFields,
      similarityScore: currentSimilarity
    };
  }
}

export default new AITemplatePipeline();
