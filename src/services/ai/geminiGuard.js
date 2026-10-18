import AppError from "../../utils/appError.js";

// GEMINI_DISABLED=true is a hard off switch for every outbound Gemini request
// in this process (geminiClient, batchClient through geminiClient.ai, and the
// three services still on the deprecated SDK). It is NOT a mock mode: nothing
// is faked, the call fails loudly with this error and the task fails with it.
// `npm test` requires it (tests/runAll.js preflight) so a test run never
// reaches a paid API.
export const geminiDisabled = () => process.env.GEMINI_DISABLED === "true";

export function assertGeminiEnabled(site) {
  if (!geminiDisabled()) return;
  console.error(`[GeminiGuard] BLOCKED Gemini call at ${site} — GEMINI_DISABLED=true, no request was sent.`);
  throw new AppError(`Gemini calls are disabled in this process (GEMINI_DISABLED=true); ${site} sent no request.`, 503);
}

// BullMQ worker name carrying the guard state, so the test preflight can see
// from Redis CLIENT LIST whether every consumer of a queue is guarded.
export const geminiWorkerName = (base) => `${base}:gemini-${geminiDisabled() ? "off" : "on"}`;
