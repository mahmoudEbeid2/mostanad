import { generateHtmlFromDesign } from "./src/services/aiTemplateService.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
  try {
    console.log("Testing with AI File...");
    const html = await generateHtmlFromDesign("C:\\Users\\A Store\\Downloads\\COA - PHARMAVET.ai", "COA - PHARMAVET.ai", "application/pdf");
    console.log("SUCCESS! Generated HTML length:", html.length);
    console.log("================== HTML OUTPUT ==================");
    console.log(html);
  } catch(e) {
    console.error("FAILED:", e);
  }
}
run();
