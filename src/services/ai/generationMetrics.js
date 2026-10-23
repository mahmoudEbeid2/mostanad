// CLAUDE.md item 5: "I have been estimating what a label costs — I want the
// real number." Every Gemini call made anywhere in the process, while a
// tracked async context is active, is folded into that context's totals —
// call it from labelGeneratorWorker (or any other entry point) with
// withGenerationMetrics(), then read snapshot() before persisting.
//
// AsyncLocalStorage rather than threading an accumulator through every
// function signature: geminiClient is called from labelGenerator.js,
// labelExtractor.js, knowledgeResolver.js, etc. — modules that don't and
// shouldn't know about "which label's metrics am I attached to." The async
// context makes that implicit and correct across await boundaries.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

export function withGenerationMetrics(fn) {
  const store = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    elapsedMs: 0,
    startedAt: Date.now(),
  };
  return als.run(store, fn);
}

/** Called by geminiClient after every attempt that returns a response — success only; a failed attempt has no usageMetadata to bill against. */
export function recordGeminiCall(usageMetadata, elapsedMs) {
  const store = als.getStore();
  if (!store) return; // no tracked context active (e.g. a script, or a call outside labelGeneratorWorker) — not an error
  store.calls += 1;
  store.inputTokens += usageMetadata?.promptTokenCount ?? 0;
  store.outputTokens += usageMetadata?.candidatesTokenCount ?? 0;
  store.thinkingTokens += usageMetadata?.thoughtsTokenCount ?? 0;
  store.cachedTokens += usageMetadata?.cachedContentTokenCount ?? 0;
  store.elapsedMs += elapsedMs;
}

/**
 * Called by geminiClient when a request was SENT and failed (429, 503, 4xx…):
 * it is a real call — counted, with its time — but has no tokens to bill.
 * A call the guard blocked (GEMINI_DISABLED) never reaches this: nothing was sent.
 */
export function recordGeminiFailedCall(elapsedMs) {
  const store = als.getStore();
  if (!store) return;
  store.calls += 1;
  store.failedCalls = (store.failedCalls || 0) + 1;
  store.elapsedMs += elapsedMs;
}

export function generationMetricsSnapshot() {
  const store = als.getStore();
  if (!store) return null;
  return {
    geminiCalls: store.calls,
    inputTokens: store.inputTokens,
    outputTokens: store.outputTokens,
    thinkingTokens: store.thinkingTokens,
    cachedTokens: store.cachedTokens,
    geminiWallClockMs: store.elapsedMs,
    totalWallClockMs: Date.now() - store.startedAt,
  };
}
