import { z } from "zod";
import { labelSchema } from "./labelSchema.js";

// Derives Gemini's structured-output schema FROM labelSchema — never hand-typed.
// @google/genai's GenerateContentConfig.responseJsonSchema accepts standard JSON
// Schema directly (an alternative to the older Gemini-specific `responseSchema`
// Schema type), so this is a straight zod -> JSON Schema conversion with no
// Gemini-specific re-encoding needed.
//
// NOT YET LIVE-VERIFIED against the Gemini API — GEMINI_API_KEY's free-tier daily
// quota was exhausted during this build (see PROGRESS.md). If Gemini rejects any
// keyword here (e.g. it may not honor `const`/`propertyNames` the same way), that
// will show up as a live 400 on first real use — re-test once quota resets before
// relying on this in production traffic.
export const geminiResponseSchema = (() => {
  const schema = z.toJSONSchema(labelSchema);
  // Gemini's JSON Schema support doesn't need (and may reject) the meta $schema key.
  const { $schema, ...rest } = schema;
  return rest;
})();
