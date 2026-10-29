import { prisma } from "../../lib/prisma.js";
import { currentAiContext } from "./aiContext.js";
import { MODEL_PRICES, priceAt, ratesFor, costUsd } from "./modelPrices.js";

// AI cost ledger: geminiClient calls recordAttempt once per request attempt
// that reached Google (retries included — each is billed). A call the guard
// blocked sent nothing and has no row. The cost is computed here, now, with the
// price in effect now, and stored with that price; reports only ever sum rows.

/** Every feature a call may be tagged with. The prefix (before the dot) is the area. */
export const FEATURES = [
  "labels.generation",
  "labels.extraction",
  "labels.knowledge",
  "labels.validation",
  "labels.audit",
  "labels.chat",
  "labels.reference",
  "products.ai",
  "regulatory.ingest",
  "regulatory.compile",
  "regulatory.coverage",
  "catalogue.extract",
  "catalogue.infer",
  "catalogue.legacy",
  "certificates.invoice",
  "certificates.mapping",
  "certificates.assist",
  "certificates.gaps",
  "certificates.matching",
  "certificates.dictionary",
  "certificates.inference",
  "certificates.web_lookup",
  "certificates.coa",
];
export const UNATTRIBUTED = "unattributed";

/** ai_runs kind → ledger feature (certificate and catalogue operations go through runLogged). */
export const FEATURE_BY_RUN_KIND = {
  INVOICE_EXTRACT: "certificates.invoice",
  CERT_FIELD_MAP: "certificates.mapping",
  CERT_ASSIST: "certificates.assist",
  CERT_INVOICE_GAPS: "certificates.gaps",
  CERT_PRODUCT_MATCH: "certificates.matching",
  CERT_DICTIONARY: "certificates.dictionary",
  CERT_PRODUCT_INFER: "certificates.inference",
  CERT_WEB_LOOKUP: "certificates.web_lookup",
  CERT_COA_EXTRACT: "certificates.coa",
  CATALOGUE_EXTRACT: "catalogue.extract",
  CATALOGUE_INFER: "catalogue.infer",
};

// Tests swap the table to check that a row uses the price in effect at call
// time; production always reads MODEL_PRICES.
let priceTable = MODEL_PRICES;
export function __setPriceTableForTests(table) {
  if (process.env.NODE_ENV === "production") throw new Error("price table override is for tests only");
  priceTable = table || MODEL_PRICES;
}

/** 429 → quota; any other failure → error. */
export const outcomeOf = (httpStatus) => (httpStatus === 429 ? "quota" : "error");

/**
 * Writes one ledger row. usage = the response's usageMetadata (absent for a
 * failed attempt — it was sent but nothing is billed against it).
 * Never throws: a ledger write failing must not fail the AI call, but it is
 * logged, never silent.
 */
export async function recordAttempt({ ledger = {}, modelId, attempt, ok, httpStatus = null, error = null, usage = null, latencyMs = 0, at = new Date() }) {
  const ctx = currentAiContext(ledger);
  const feature = ctx.feature && FEATURES.includes(ctx.feature) ? ctx.feature : UNATTRIBUTED;
  if (feature === UNATTRIBUTED) console.error(`[aiLedger] a Gemini call (${modelId}) has no known feature (got "${ctx.feature ?? ""}") — recorded as "${UNATTRIBUTED}"`);
  const tokens = {
    inputTokens: usage?.promptTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thinkingTokens: usage?.thoughtsTokenCount ?? 0,
  };
  const price = priceAt(modelId, at, priceTable);
  const rates = ratesFor(price, tokens.inputTokens);
  const cost = costUsd(tokens, rates);
  const data = {
    companyId: ctx.companyId ?? null,
    userId: ctx.userId ?? null,
    feature,
    entityType: ctx.entityType ?? null,
    entityId: ctx.entityId ?? null,
    parentType: ctx.parentType ?? null,
    parentId: ctx.parentId ?? null,
    aiRunId: ctx.aiRunId ?? null,
    meta: ctx.meta ?? undefined,
    modelId: String(modelId),
    attempt,
    outcome: ok ? "ok" : outcomeOf(httpStatus),
    httpStatus: ok ? null : httpStatus,
    error: error ? String(error).slice(0, 1000) : null,
    ...tokens,
    latencyMs: Math.round(latencyMs),
    costUsd: cost,
    priceEffectiveFrom: rates ? new Date(`${price.effectiveFrom}T00:00:00Z`) : null,
    priceInputPerM: rates?.inputPerMillion ?? null,
    priceCachedPerM: rates?.cachedInputPerMillion ?? null,
    priceOutputPerM: rates?.outputPerMillion ?? null,
    createdAt: at,
  };
  try {
    return await prisma.aiCall.create({ data });
  } catch (err) {
    console.error(`[aiLedger] could not record a ${feature} call (${modelId}, attempt ${attempt}): ${err.message}`);
    return null;
  }
}

/**
 * A job's calls are made before the thing it creates exists (a label's
 * generation): once it does, point that task's rows at it. Attribution only —
 * the cost and every other recorded value stay as written.
 */
export async function linkTaskCalls(taskId, parentType, parentId) {
  if (!taskId) return 0;
  const { count } = await prisma.aiCall.updateMany({ where: { entityType: "background_task", entityId: taskId, parentId: null }, data: { parentType, parentId } });
  return count;
}
