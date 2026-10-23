// What a person sees when an AI call failed (plan.md P8). The raw text —
// Google's status and message, our env flags and model ids — is for the
// operators: it stays in ai_runs.error, BackgroundTask/invoice/catalogue rows
// and the server log. Anything shown to a user goes through publicAiError(),
// which keeps a non-AI message as it is and turns an AI failure into a
// sentence that says what happened and what to do.

// only text that is about the AI at all is rewritten ("Template unavailable" is not)
const AI_MARKER = /\bGemini\b|GEMINI_|generateContent|generateJson|gemini-[\w.-]+|\bAI returned\b|RESOURCE_EXHAUSTED|API_KEY_INVALID/i;

const RULES = [
  [/GEMINI_DISABLED|Gemini calls are disabled/i, "AI_DISABLED", "AI is switched off on this server, so this wasn't done automatically. You can do it by hand."],
  [/GEMINI_API_KEY|API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i, "AI_NOT_CONFIGURED", "AI isn't set up correctly on this server, so this wasn't done automatically. You can do it by hand."],
  [/quota exhausted|RESOURCE_EXHAUSTED|status 429|\b429\b/i, "AI_QUOTA", "AI has reached its usage limit for now. You can do this by hand, or try again later."],
  [/status 503|\b503\b|overloaded|UNAVAILABLE|server busy/i, "AI_BUSY", "The AI service is busy right now. Try again in a few minutes, or do this by hand."],
  [/malformed JSON|did not match the schema|invalid JSON/i, "AI_BAD_ANSWER", "The AI's answer couldn't be used. Try again, or do this by hand."],
  [/\bGemini\b|generateContent|generateJson|gemini-[\w.-]+/i, "AI_FAILED", "The AI service couldn't answer. Try again, or do this by hand."],
];

/** → { code, message } for an AI failure, or null when the text isn't one. */
export function describeAiError(raw) {
  const text = typeof raw === "string" ? raw : raw?.message || "";
  if (!text || !AI_MARKER.test(text)) return null;
  for (const [re, code, message] of RULES) if (re.test(text)) return { code, message };
  return null;
}

/** The text a user may see for this error: the friendly AI sentence, or the message unchanged. */
export function publicAiError(raw) {
  const text = typeof raw === "string" ? raw : raw?.message || "";
  return describeAiError(text)?.message ?? text;
}

const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,}): /;

/**
 * For API rows with a stored `error`: the user-facing text plus its code; the
 * raw text stays in the database. A stored "EXTRACTION_FAILED: …" loses the
 * internal prefix too (it becomes errorCode when no AI code applies).
 */
export function presentError(row) {
  if (!row?.error) return row;
  const d = describeAiError(row.error);
  if (d) return { ...row, error: d.message, errorCode: d.code };
  const m = row.error.match(CODE_PREFIX);
  return m ? { ...row, error: row.error.slice(m[0].length), errorCode: m[1] } : row;
}
