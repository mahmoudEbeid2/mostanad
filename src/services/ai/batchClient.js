import geminiClient from "./geminiClient.js";

// §9.8 / CLAUDE.md: "Batch API (50% cost) for everything non-interactive."
// Thin wrapper around @google/genai's `ai.batches` module (verified present in
// the installed SDK — see PROGRESS.md's Phase 9 entry). The Gemini Developer
// API (this project uses an API key, not Vertex/GCS) supports batch jobs built
// from `inlinedRequests` — no GCS bucket needed — which is what this wrapper
// uses exclusively. GCS/BigQuery sources are intentionally not supported here.
//
// VERIFIED LIVE (Phase 9): ai.batches.create() against this project's actual
// GEMINI_API_KEY returns 400 FAILED_PRECONDITION ("Precondition check
// failed.") immediately, before any job is queued. This is Gemini's generic
// error for "Batch API is not available on this account" — the Developer
// API's Batch API requires a billing-enabled (paid-tier) project; this
// environment only has a free-tier key. The wrapper itself is real and
// correct (the call reaches Google's servers and gets a structured API error
// back, not a client-side/plumbing failure) — it is unverified against a
// completed real batch job because no such job can be created here. See
// PROGRESS.md's Phase 9 entry: enabling billing on the Gemini project is a
// "needed from you" item if batch cost savings matter.

export const TERMINAL_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_PARTIALLY_SUCCEEDED",
]);

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

/**
 * Builds one InlinedRequest from the same parameter shape geminiClient.generateJson
 * accepts, so call sites can move between interactive and batch calls without
 * reshaping their inputs.
 */
export function buildInlinedRequest({ contents, systemInstruction, schema, temperature = 0, thinkingBudget, maxOutputTokens = 8192, metadata }) {
  const config = {
    temperature,
    maxOutputTokens,
    ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
  };
  if (thinkingBudget !== undefined) {
    config.thinkingConfig = { thinkingBudget };
  }
  return { contents, config, ...(metadata ? { metadata } : {}) };
}

/**
 * Submits a batch job of inline requests. `items` is an array of the same
 * shape `buildInlinedRequest` takes. Returns the created BatchJob (has `.name`,
 * `.state` — QUEUED/PENDING at creation, never immediately terminal).
 */
export async function createBatch({ model, items }) {
  const inlinedRequests = items.map(buildInlinedRequest);
  return geminiClient.ai.batches.create({ model, src: { inlinedRequests } });
}

export async function getBatch(name) {
  return geminiClient.ai.batches.get({ name });
}

export async function cancelBatch(name) {
  return geminiClient.ai.batches.cancel({ name });
}

/**
 * Extracts {metadata, json|text, error} per item from a terminal, succeeded
 * (or partially-succeeded) BatchJob built from inlined requests. Pure — takes
 * the already-fetched BatchJob.
 */
export function parseBatchResults(batchJob) {
  const responses = batchJob?.dest?.inlinedResponses || [];
  return responses.map((r) => {
    if (r.error) return { metadata: r.metadata, error: r.error };
    const text = r.response?.text;
    try {
      let clean = (text || "").trim();
      if (clean.startsWith("```json")) {
        clean = clean.slice(7);
        if (clean.endsWith("```")) clean = clean.slice(0, -3);
      }
      return { metadata: r.metadata, json: JSON.parse(clean.trim()), text };
    } catch {
      return { metadata: r.metadata, text };
    }
  });
}
