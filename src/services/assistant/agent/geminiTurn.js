import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

// One model call of the agent loop, through geminiClient (rate limiter, retries,
// AI cost ledger). Function calling only: the tools are declarations; geminiClient
// never runs them — the loop does, through the registry.
//
// Context caching: geminiClient has no explicit cache (caches.create). The system
// prompt and the tool declarations are a stable prefix of every call, so Gemini's
// implicit caching applies; the ledger's cachedTokens shows whether it does.

export const ASSISTANT_MODEL = MODELS.ASSISTANT;

/** → generate() for runAgent, billing every call to `ledger` ({ companyId, userId, entityId: conversationId, meta }). */
export function geminiGenerate(ledger) {
  return async ({ systemInstruction, contents, tools, mode }) => {
    const response = await geminiClient.generateContentWithRetry(
      {
        model: ASSISTANT_MODEL.id,
        contents,
        systemInstruction,
        config: {
          temperature: ASSISTANT_MODEL.temperature,
          thinkingConfig: { thinkingBudget: ASSISTANT_MODEL.thinkingBudget },
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
          toolConfig: { functionCallingConfig: { mode } },
          automaticFunctionCalling: { disable: true },
        },
        ledger: { feature: "assistant.chat", entityType: "assistant_conversation", ...ledger },
      },
      2 // an interactive answer: two tries, not five
    );
    const content = response.candidates?.[0]?.content || { role: "model", parts: [] };
    return { content: { role: "model", parts: content.parts || [] }, usage: response.usageMetadata || {} };
  };
}
