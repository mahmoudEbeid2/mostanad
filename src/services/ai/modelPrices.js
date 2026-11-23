import { MODEL_IDS } from "./modelRegistry.js";

// AI cost ledger — the ONLY place a model price lives. Nothing else in the
// codebase may hold a price (no env defaults, no constants in reports): the
// ledger (aiLedger.js) prices each Gemini attempt with the entry in effect at
// call time and stores that price on the row, so changing this file only
// affects calls made after the change.
//
// HOW TO FILL IT IN — from Google's pricing page for the Gemini API (paid tier):
//   https://ai.google.dev/gemini-api/docs/pricing
// Every amount is USD per 1,000,000 tokens:
//   inputPerMillion        — "Input price" (text/image/video; the prompt)
//   cachedInputPerMillion  — "Context caching price" (cached prompt tokens are
//                            billed at this rate INSTEAD of the input rate)
//   outputPerMillion       — "Output price (including thinking tokens)"
//   longContext            — only for models priced higher above a prompt size
//                            (e.g. Pro "prompts > 200k tokens"): the threshold
//                            in prompt tokens and the three rates above it; null
//                            when the model has a single tier.
// effectiveFrom is the UTC date the price starts to apply. To change a price,
// ADD a new entry with a later effectiveFrom — never edit an old one, or the
// file stops explaining the prices already stored on old rows.
//
// While an amount is null the ledger still records every call and its tokens,
// with costUsd = null; the reports count those calls as "unpriced".

// Filled 2026-11-23 from https://ai.google.dev/gemini-api/docs/pricing (paid
// tier, Standard, text/image/video input; audio input is priced higher and is
// not used here). `flex` holds the Flex/Batch rates (half of Standard) for
// calls sent with serviceTier "flex"; null where the page shows none.
const r = (inputPerMillion, cachedInputPerMillion, outputPerMillion) => ({ inputPerMillion, cachedInputPerMillion, outputPerMillion });

export const MODEL_PRICES = [
  // Prices before 2026-11-23 were never filled in: rows written then stay unpriced.
  { modelId: MODEL_IDS.GEMINI_2_5_FLASH, effectiveFrom: "2026-11-23", ...r(0.3, 0.03, 2.5), flex: r(0.15, 0.03, 1.25), longContext: null },
  { modelId: MODEL_IDS.GEMINI_3_1_FLASH_LITE, effectiveFrom: "2026-05-07", ...r(0.25, 0.025, 1.5), flex: r(0.125, 0.0125, 0.75), longContext: null },
  { modelId: MODEL_IDS.GEMINI_3_5_FLASH_LITE, effectiveFrom: "2026-07-21", ...r(0.3, 0.03, 2.5), flex: null, longContext: null },
  // the page announces a doubling from 2027-01-01
  { modelId: MODEL_IDS.GEMINI_3_8_FLASH, effectiveFrom: "2026-09-02", ...r(0.75, 0.075, 3.75), flex: r(0.375, 0.0375, 1.875), longContext: null },
  { modelId: MODEL_IDS.GEMINI_3_8_FLASH, effectiveFrom: "2027-01-01", ...r(1.5, 0.15, 7.5), flex: r(0.75, 0.075, 3.75), longContext: null },
  {
    modelId: MODEL_IDS.GEMINI_2_5_PRO,
    effectiveFrom: "2025-01-01",
    inputPerMillion: null, // TODO(owner): prompts ≤ 200k tokens
    cachedInputPerMillion: null, // TODO(owner)
    outputPerMillion: null, // TODO(owner) — includes thinking tokens
    longContext: { aboveInputTokens: 200_000, inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null }, // TODO(owner): prompts > 200k
  },
];

const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The entry in effect for `modelId` at `at`: the one with the latest
 * effectiveFrom that is not after `at`. null when none applies.
 */
export function priceAt(modelId, at = new Date(), table = MODEL_PRICES) {
  const t = new Date(at).getTime();
  let best = null;
  for (const p of table) {
    if (p.modelId !== modelId) continue;
    const from = Date.parse(`${p.effectiveFrom}T00:00:00Z`);
    if (from > t) continue;
    if (!best || from > Date.parse(`${best.effectiveFrom}T00:00:00Z`)) best = p;
  }
  return best;
}

/**
 * The rates that apply to one request under `price` (the Flex rates for a
 * serviceTier "flex" call, the long-context tier when the prompt is above its
 * threshold), or null when any rate is missing.
 */
export function ratesFor(price, inputTokens = 0, serviceTier = null) {
  if (!price) return null;
  const tier =
    serviceTier === "flex" ? price.flex ?? null : price.longContext && inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
  if (!tier) return null;
  const rates = { inputPerMillion: tier.inputPerMillion, cachedInputPerMillion: tier.cachedInputPerMillion, outputPerMillion: tier.outputPerMillion };
  return Object.values(rates).every(isPrice) ? rates : null;
}

/**
 * USD for one request. Cached prompt tokens are part of promptTokenCount and
 * are billed at the cached rate instead of the input rate; thinking tokens
 * (thoughtsTokenCount) are billed as output. null when the rates are unknown.
 */
export function costUsd({ inputTokens = 0, cachedTokens = 0, outputTokens = 0, thinkingTokens = 0 }, rates) {
  if (!rates) return null;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * rates.inputPerMillion + Math.min(cachedTokens, inputTokens) * rates.cachedInputPerMillion + (outputTokens + thinkingTokens) * rates.outputPerMillion) / 1e6;
}
