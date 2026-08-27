import { GoogleGenAI } from "@google/genai";

class GeminiClient {
  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateContentWithRetry({ model, contents, systemInstruction, config = {} }, retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`[GeminiClient] Requesting content from ${model} (Attempt ${i + 1}/${retries})...`);
        return await this.ai.models.generateContent({
          model,
          contents,
          config: systemInstruction ? { systemInstruction, ...config } : config,
        });
      } catch (error) {
        console.warn(`[GeminiClient] Attempt ${i + 1} failed: ${error.message}`);

        if (i === retries - 1) {
          throw new Error(`Gemini API failed after ${retries} attempts: ${error.message}`);
        }
        const delay = Math.min(2000 * Math.pow(2, i), 15000);
        console.log(`[GeminiClient] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Plain text generation (no forced JSON), e.g. raw document text extraction.
   */
  async generateText({ model, contents, systemInstruction, config = {} }, retries = 5) {
    const response = await this.generateContentWithRetry({ model, contents, systemInstruction, config }, retries);
    return response.text;
  }

  async generateJson({ model, contents, systemInstruction, schema, maxOutputTokens = 8192, temperature = 0, thinkingBudget }, retries = 5) {
    const config = {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    };
    if (thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget };
    }

    const response = await this.generateContentWithRetry({ model, contents, systemInstruction, config }, retries);
    const text = response.text;

    try {
      let cleanText = (text || "").trim();
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

  // File API — replaces GoogleAIFileManager from the deprecated @google/generative-ai/server.
  async uploadFile(filePath, { mimeType, displayName } = {}) {
    return this.ai.files.upload({ file: filePath, config: { mimeType, displayName } });
  }

  async getFile(name) {
    return this.ai.files.get({ name });
  }

  async deleteFile(name) {
    return this.ai.files.delete({ name });
  }
}

export default new GeminiClient();
