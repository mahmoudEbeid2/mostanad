import { GoogleGenerativeAI } from "@google/generative-ai";

class GeminiClient {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  async generateContentWithRetry({ model, contents, systemInstruction, generationConfig }, retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        const generativeModel = this.genAI.getGenerativeModel({
          model,
          systemInstruction,
          generationConfig
        });
        
        console.log(`[GeminiClient] Requesting content from ${model} (Attempt ${i + 1}/${retries})...`);
        const response = await generativeModel.generateContent(contents);
        return response.response.text();
      } catch (error) {
        console.warn(`[GeminiClient] Attempt ${i + 1} failed: ${error.message}`);
        
        let currentModel = model;
        if (error.message.includes("404") || error.message.includes("not found")) {
            if (model.includes("gemini-1.5")) currentModel = "gemini-2.5-pro";
        }
        
        if (i === retries - 1) {
          throw new Error(`Gemini API failed after ${retries} attempts: ${error.message}`);
        }
        const delay = Math.min(2000 * Math.pow(2, i), 15000);
        console.log(`[GeminiClient] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async generateJson({ model, contents, systemInstruction, schema, maxOutputTokens = 8192 }, retries = 5) {
    const generationConfig = {
      temperature: 0.0,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema
    };
    
    const text = await this.generateContentWithRetry({ model, contents, systemInstruction, generationConfig }, retries);
    
    try {
      let cleanText = text.trim();
      if (cleanText.startsWith("```json")) {
         cleanText = cleanText.substring(7);
         if (cleanText.endsWith("```")) cleanText = cleanText.substring(0, cleanText.length - 3);
      }
      return JSON.parse(cleanText.trim());
    } catch (error) {
      console.error("[GeminiClient] Failed to parse JSON response:", text ? text.substring(0, 500) : "null");
      throw new Error("AI returned malformed JSON.");
    }
  }
}

export default new GeminiClient();
