import { GoogleGenAI } from "@google/genai";
import { GeminiRateLimiter } from "./rateLimiter.js";
import { parseGeminiError } from "./geminiErrors.js";
import { recordGeminiCall, recordGeminiFailedCall } from "./generationMetrics.js";
import { assertGeminiEnabled } from "./geminiGuard.js";
import { recordAttempt } from "./aiLedger.js";

// CLAUDE.md "SHARED RATE LIMITER — the real fix": this is the ONLY place a
// GoogleGenAI client is constructed in this codebase. Every worker and
// service must call through geminiClient — a per-file client (as several did
// before this fix) means a per-file quota view, which is exactly how one
// process fires 429s against a single-key quota while each caller thinks it's
// behaving. If you're adding a new Gemini call site, import this file; do not
// `new GoogleGenAI(...)` anywhere else.
//
// Defaults are conservative on purpose — safe for a free-tier key shared
// across every worker in dev:all, not tuned for a paid key's real ceiling.
// Raise both for a paid project via env; check the account's actual quota at
// https://ai.google.dev/gemini-api/docs/rate-limits before raising them.
const GEMINI_RPM = Number(process.env.GEMINI_RPM) || 8;
const GEMINI_MAX_CONCURRENT = Number(process.env.GEMINI_MAX_CONCURRENT) || 2;

class GeminiClient {
  constructor() {
    this._ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.limiter = new GeminiRateLimiter({ requestsPerMinute: GEMINI_RPM, maxConcurrent: GEMINI_MAX_CONCURRENT });
    console.log(`[GeminiClient] Rate limiter active: ${GEMINI_RPM} req/min, ${GEMINI_MAX_CONCURRENT} concurrent (override with GEMINI_RPM / GEMINI_MAX_CONCURRENT).`);
  }

  // Every SDK access — the methods below and batchClient's ai.batches.* —
  // goes through this getter, so GEMINI_DISABLED blocks all of them.
  get ai() {
    assertGeminiEnabled("geminiClient");
    return this._ai;
  }

  /**
   * The single choke point every generateContent call passes through: rate
   * limiter first (queues instead of firing over-quota), then a retry loop
   * that treats 429 and 503 as different problems (CLAUDE.md item 2):
   *   - 503 (server busy): exponential backoff — Google will recover.
   *   - 429, per-minute or unclassified: honour Google's own RetryInfo
   *     retryDelay when given, otherwise a conservative fallback. Worth
   *     waiting out.
   *   - 429, daily/project quota: NOT worth waiting out — fails immediately
   *     with a message that says so, instead of burning the retry budget.
   *   - anything else (4xx auth/validation errors, malformed request, ...):
   *     not transient — surfaced on the first attempt, never retried.
   * Every failed attempt is logged with Google's real status/message/retry
   * metadata (item 3) — nothing here collapses to "API busy (503/429)".
   *
   * AI cost ledger: every attempt that reached Google — answered or failed,
   * first try or retry — writes exactly one ai_calls row (aiLedger), tagged
   * with `ledger` ({ feature, entityType, entityId, companyId, … }) over the
   * async AI context. A call the guard blocked writes none: nothing was sent.
   */
  async generateContentWithRetry({ model, contents, systemInstruction, config = {}, ledger = {} }, retries = 5) {
    let lastParsed = null;
    // Checked before the limiter so a blocked call never waits for a slot.
    assertGeminiEnabled(`geminiClient.generateContent(${model})`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.limiter.acquire();
      const startedAt = Date.now();
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents,
          config: systemInstruction ? { systemInstruction, ...config } : config,
        });
        this.limiter.release();
        const latencyMs = Date.now() - startedAt;
        recordGeminiCall(response.usageMetadata, latencyMs);
        await recordAttempt({ ledger, modelId: model, attempt, ok: true, usage: response.usageMetadata, latencyMs });
        return response;
      } catch (error) {
        this.limiter.release();
        const latencyMs = Date.now() - startedAt;
        recordGeminiFailedCall(latencyMs); // the request went out (the guard runs before the loop)
        const parsed = parseGeminiError(error);
        lastParsed = parsed;
        await recordAttempt({ ledger, modelId: model, attempt, ok: false, httpStatus: parsed.httpStatus ?? null, error: parsed.googleMessage, latencyMs });
        console.error(
          `[GeminiClient] ${model} attempt ${attempt}/${retries} failed — ` +
            `status=${parsed.httpStatus ?? "unknown"} quotaScope=${parsed.quotaScope ?? "n/a"} ` +
            `retryDelayMs=${parsed.retryDelayMs ?? "n/a"} message="${parsed.googleMessage}"`
        );

        if (parsed.httpStatus === 429 && parsed.quotaScope === "daily") {
          throw new Error(
            `Gemini quota exhausted (daily/project limit, not per-minute) for ${model} — retrying will not help until it resets. ${parsed.googleMessage}`
          );
        }

        const isRetryableStatus = parsed.httpStatus === 429 || parsed.httpStatus === 503;
        if (!isRetryableStatus) {
          throw new Error(`Gemini API call failed for ${model} (status ${parsed.httpStatus ?? "unknown"}): ${parsed.googleMessage}`);
        }

        if (attempt === retries) {
          throw new Error(
            `Gemini API call failed for ${model} after ${retries} attempts (last status ${parsed.httpStatus}): ${parsed.googleMessage}`
          );
        }

        const delay =
          parsed.httpStatus === 503
            ? Math.min(2000 * Math.pow(2, attempt - 1), 15000) // unchanged: exponential backoff for "server busy"
            : parsed.retryDelayMs ?? Math.min(5000 * attempt, 30000); // 429: honour Google's timing, else a conservative fallback
        console.log(`[GeminiClient] Retrying ${model} in ${delay}ms (reason: ${parsed.httpStatus === 503 ? "server busy" : "rate limit"})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Unreachable in practice (the loop always throws on its last attempt) —
    // kept as a defensive fallback so a future refactor can't silently return
    // undefined instead of failing loudly.
    throw new Error(`Gemini API call failed for ${model}: ${lastParsed?.googleMessage ?? "unknown error"}`);
  }

  /**
   * Plain text generation (no forced JSON), e.g. raw document text extraction.
   */
  async generateText({ model, contents, systemInstruction, config = {}, ledger }, retries = 5) {
    const response = await this.generateContentWithRetry({ model, contents, systemInstruction, config, ledger }, retries);
    return response.text;
  }

  async generateJson({ model, contents, systemInstruction, schema, maxOutputTokens = 8192, temperature = 0, thinkingBudget, ledger }, retries = 5) {
    const config = {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    };
    if (thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget };
    }

    const response = await this.generateContentWithRetry({ model, contents, systemInstruction, config, ledger }, retries);
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
  // Not routed through the rate limiter: the Files API has its own separate
  // quota from generateContent, so gating it on the generation budget would
  // just make uploads wait behind an unrelated limit for no reason.
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
