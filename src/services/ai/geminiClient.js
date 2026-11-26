import { GoogleGenAI } from "@google/genai";
import { GeminiRateLimiter } from "./rateLimiter.js";
import { parseGeminiError } from "./geminiErrors.js";
import { recordGeminiCall, recordGeminiFailedCall } from "./generationMetrics.js";
import { assertGeminiEnabled } from "./geminiGuard.js";
import { recordAttempt } from "./aiLedger.js";
import { currentAiContext } from "./aiContext.js";
import { fallbackModel, thinkingConfigFor, timeoutForFeature, serviceTierForFeature } from "./modelRegistry.js";

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

// Retry policy (2026-11-23). Env-tunable; tests set geminiClient.policy directly.
const envNum = (name, dflt) => {
  const v = process.env[name];
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : dflt;
};
export const DEFAULT_POLICY = {
  maxAttempts: envNum("AI_MAX_ATTEMPTS", 4), // per call, the fallback's attempts included
  totalTimeMs: envNum("AI_RETRY_TOTAL_MS", 180_000), // no retry starts past this, counted from the first attempt
  baseDelayMs: envNum("AI_RETRY_BASE_MS", 1000),
  maxDelayMs: envNum("AI_RETRY_MAX_DELAY_MS", 20_000),
  fallbackAfterOverloads: envNum("AI_FALLBACK_AFTER", 2), // overloads in a row, in one call, before it moves to AI_MODEL_FALLBACK
  breakerThreshold: envNum("AI_BREAKER_THRESHOLD", 3), // overloads in a row (any caller) that pause a model
  breakerPauseMs: envNum("AI_BREAKER_PAUSE_MS", 60_000),
  timeoutMs: null, // null: per feature area (modelRegistry.timeoutForFeature)
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Statuses worth another try. A 429 reaching this check is per-minute or
// unclassified: a daily quota is refused before it.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// "Overloaded": the failures that count toward fallback and the breaker. The
// model has no capacity right now; another model may.
const isOverload = (parsed) => Boolean(parsed.timedOut) || parsed.httpStatus === 503 || /overloaded|high demand|UNAVAILABLE/i.test(parsed.googleMessage || "");

/** Retry-After (seconds or an HTTP date) from an SDK error's response headers, in ms; null when absent. */
export function retryAfterMs(error, now = Date.now()) {
  const h = error?.headers ?? error?.response?.headers;
  if (!h) return null;
  const raw = typeof h.get === "function" ? h.get("retry-after") : h["retry-after"] ?? h["Retry-After"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (/^\d+(\.\d+)?$/.test(String(raw).trim())) return Math.ceil(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * Per-model circuit breaker, process-wide (every caller shares the key):
 * `breakerThreshold` overloads in a row open it for `breakerPauseMs`; while
 * open the model is skipped (the fallback answers, or the call fails at once).
 * After the pause the next call goes through: success closes it, another
 * overload run reopens it.
 */
export class CircuitBreaker {
  constructor(policy) {
    this.policy = policy;
    this.models = new Map();
  }
  state(model) {
    if (!this.models.has(model)) this.models.set(model, { overloads: 0, openUntil: 0 });
    return this.models.get(model);
  }
  isOpen(model, now = Date.now()) {
    return this.state(model).openUntil > now;
  }
  /** → true when this overload opened the breaker */
  overload(model, now = Date.now()) {
    const st = this.state(model);
    st.overloads += 1;
    if (st.overloads >= this.policy.breakerThreshold && st.openUntil <= now) {
      st.openUntil = now + this.policy.breakerPauseMs;
      st.overloads = 0;
      return true;
    }
    return false;
  }
  success(model) {
    const st = this.state(model);
    st.overloads = 0;
    st.openUntil = 0;
  }
  snapshot(now = Date.now()) {
    return [...this.models.entries()].map(([model, st]) => ({
      model,
      paused: st.openUntil > now,
      overloadsInARow: st.overloads,
      pausedUntil: st.openUntil > now ? new Date(st.openUntil).toISOString() : null,
    }));
  }
  reset() {
    this.models.clear();
  }
}

// The model that answered, on what generateContentWithRetry / generateJson
// return: provenance must name it (the fallback may have answered, not the
// task's configured model). modelUsed(result, configured) reads it.
const MODEL_USED = Symbol.for("mostanad.ai.modelUsed");
export const modelUsed = (result, configured) => (result && typeof result === "object" && result[MODEL_USED]) || configured;
const tagModel = (result, model) => {
  if (result && typeof result === "object") Object.defineProperty(result, MODEL_USED, { value: model, enumerable: false, configurable: true });
  return result;
};

class GeminiClient {
  constructor() {
    this._ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.limiter = new GeminiRateLimiter({ requestsPerMinute: GEMINI_RPM, maxConcurrent: GEMINI_MAX_CONCURRENT });
    this.policy = { ...DEFAULT_POLICY };
    this.breaker = new CircuitBreaker(this.policy);
    console.log(`[GeminiClient] Rate limiter active: ${GEMINI_RPM} req/min, ${GEMINI_MAX_CONCURRENT} concurrent (override with GEMINI_RPM / GEMINI_MAX_CONCURRENT).`);
  }

  // Every SDK access — the methods below and batchClient's ai.batches.* —
  // goes through this getter, so GEMINI_DISABLED blocks all of them.
  get ai() {
    assertGeminiEnabled("geminiClient");
    return this._ai;
  }

  /** Tests: replace the policy (the breaker reads the same object) and clear the breaker. */
  setPolicy(overrides = {}) {
    Object.assign(this.policy, DEFAULT_POLICY, overrides);
    this.breaker.reset();
  }

  /** One request with a client-side timeout: aborts the SDK call and rejects as a retryable timeout. */
  async _send(request, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { timedOut: true }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.ai.models.generateContent({ ...request, config: { ...request.config, abortSignal: controller.signal } }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The single choke point every generateContent call passes through: rate
   * limiter first (queues instead of firing over-quota), then:
   *   - 429 per-minute/unclassified, 500, 502, 503, 504 and timeouts are
   *     retried — at most policy.maxAttempts tries (never more than `retries`),
   *     none starting after policy.totalTimeMs — waiting Google's own
   *     RetryInfo / Retry-After when given, else exponential backoff + jitter;
   *   - 429 daily/project quota: fails at once — waiting will not help;
   *   - anything else (4xx auth/validation, malformed request): fails at once;
   *   - overload (503 / "high demand" / timeout) policy.fallbackAfterOverloads
   *     times in a row → the remaining tries go to AI_MODEL_FALLBACK, and an
   *     open circuit breaker on the requested model sends the call there
   *     directly. The switch is on each ledger row it affects (meta.routing).
   * thinkingConfig is translated for the model actually called
   * (thinkingConfigFor), so a 2.5-style budget works on 3.x and on the fallback.
   * Every failed attempt is logged with Google's real status/message/retry
   * metadata — nothing here collapses to "API busy (503/429)".
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

    const policy = this.policy;
    const maxAttempts = Math.max(1, Math.min(retries, policy.maxAttempts));
    const feature = currentAiContext(ledger).feature;
    // per call (28 Nov, the harvest): its own timeout, and no fallback — a task that must stay on
    // its model (a Pro read of a whole drop) fails and retries rather than run on a smaller one
    const { allowFallback = true, timeoutMs: callTimeoutMs = null, ...rest } = config;
    config = rest;
    const timeoutMs = policy.timeoutMs ?? callTimeoutMs ?? timeoutForFeature(feature);
    const serviceTier = config.serviceTier ?? serviceTierForFeature(feature);
    const fallback = fallbackModel();
    const canFallBack = allowFallback && Boolean(fallback) && fallback !== model;
    let firstAt = null; // the first request's send time: queueing behind the limiter doesn't count
    let current = model;
    let routing = null;
    let overloadsInARow = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (current === model && this.breaker.isOpen(model)) {
        if (canFallBack && !this.breaker.isOpen(fallback)) {
          current = fallback;
          routing = { fallbackFrom: model, reason: "circuit_open" };
          console.warn(`[GeminiClient] ${model} is paused (circuit breaker) — sending to fallback ${fallback}`);
        } else {
          throw new Error(
            `Gemini API call failed for ${model} (status 503): the model is overloaded and paused after repeated overloads${canFallBack ? `; the fallback ${fallback} is paused too` : ""}.`
          );
        }
      }
      const callConfig = { ...config };
      if (config.thinkingConfig) callConfig.thinkingConfig = thinkingConfigFor(current, config.thinkingConfig);
      if (serviceTier) callConfig.serviceTier = serviceTier;
      if (systemInstruction) callConfig.systemInstruction = systemInstruction;

      await this.limiter.acquire();
      const startedAt = Date.now();
      firstAt ??= startedAt;
      try {
        const response = await this._send({ model: current, contents, config: callConfig }, timeoutMs);
        this.limiter.release();
        const latencyMs = Date.now() - startedAt;
        this.breaker.success(current);
        recordGeminiCall(response.usageMetadata, latencyMs, current);
        await recordAttempt({ ledger, modelId: current, attempt, ok: true, usage: response.usageMetadata, latencyMs, serviceTier, routing });
        return tagModel(response, current);
      } catch (error) {
        this.limiter.release();
        const latencyMs = Date.now() - startedAt;
        recordGeminiFailedCall(latencyMs); // the request went out (the guard runs before the loop)
        const parsed = error?.timedOut
          ? { httpStatus: null, googleMessage: error.message, retryDelayMs: null, quotaScope: null, timedOut: true }
          : parseGeminiError(error);
        if (parsed.retryDelayMs == null) parsed.retryDelayMs = retryAfterMs(error);
        lastParsed = parsed;
        const statusText = parsed.timedOut ? "timeout" : parsed.httpStatus ?? "unknown";
        await recordAttempt({ ledger, modelId: current, attempt, ok: false, httpStatus: parsed.httpStatus ?? null, error: parsed.googleMessage, latencyMs, serviceTier, routing });
        console.error(
          `[GeminiClient] ${current} attempt ${attempt}/${maxAttempts} failed — ` +
            `status=${statusText} quotaScope=${parsed.quotaScope ?? "n/a"} ` +
            `retryDelayMs=${parsed.retryDelayMs ?? "n/a"} message="${parsed.googleMessage}"`
        );

        if (parsed.httpStatus === 429 && parsed.quotaScope === "daily") {
          throw new Error(
            `Gemini quota exhausted (daily/project limit, not per-minute) for ${current} — retrying will not help until it resets. ${parsed.googleMessage}`
          );
        }
        if (!parsed.timedOut && !RETRYABLE.has(parsed.httpStatus)) {
          throw new Error(`Gemini API call failed for ${current} (status ${statusText}): ${parsed.googleMessage}`);
        }

        const failedOn = current;
        if (isOverload(parsed)) {
          overloadsInARow += 1;
          if (this.breaker.overload(current)) console.warn(`[GeminiClient] ${current}: ${policy.breakerThreshold} overloads in a row — paused for ${policy.breakerPauseMs} ms`);
          if (current === model && canFallBack && overloadsInARow >= policy.fallbackAfterOverloads && !this.breaker.isOpen(fallback)) {
            current = fallback;
            routing = { fallbackFrom: model, reason: "overloaded" };
            console.warn(`[GeminiClient] ${model} overloaded ${overloadsInARow}× in a row — next try on the fallback ${fallback}`);
          }
        } else {
          overloadsInARow = 0;
        }

        if (attempt === maxAttempts) {
          throw new Error(`Gemini API call failed for ${failedOn} after ${attempt} attempts (last status ${statusText}): ${parsed.googleMessage}`);
        }

        const backoff = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
        // Google's own timing when given; otherwise "equal jitter": half fixed, half random
        const delay = parsed.retryDelayMs ?? Math.round(backoff / 2 + Math.random() * (backoff / 2));
        if (Date.now() - firstAt + delay > policy.totalTimeMs) {
          throw new Error(
            `Gemini API call failed for ${failedOn} after ${attempt} attempts (last status ${statusText}; the next try would pass the ${Math.round(policy.totalTimeMs / 1000)} s limit): ${parsed.googleMessage}`
          );
        }
        console.log(`[GeminiClient] Retrying ${current} in ${delay}ms (reason: ${parsed.timedOut ? "timeout" : parsed.httpStatus === 429 ? "rate limit" : "server busy"})...`);
        await sleep(delay);
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
      return tagModel(JSON.parse(cleanText.trim()), modelUsed(response, model));
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
