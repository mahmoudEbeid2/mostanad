import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { withGenerationMetrics, generationMetricsSnapshot } from "../../ai/generationMetrics.js";
import { withAiContext } from "../../ai/aiContext.js";
import { FEATURE_BY_RUN_KIND } from "../../ai/aiLedger.js";

// aiRunLog (plan.md §3.3): every certificate-AI model call is recorded — kind,
// company, entity, inputHash, promptHash, modelId, tokens, ms, outcome — in
// `ai_runs`, through generationMetrics (so tokens are the real usage the
// provider reported). Calls that were NOT made are recorded too ("disabled",
// "skipped"), so "why didn't the AI run?" always has an answer.

/** JSON with sorted object keys — the same input always hashes the same. */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  return `{${Object.keys(v)
    .sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

export const sha16 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
export const hashInput = (input) => sha16(stableStringify(input));

async function writeRun(data) {
  try {
    return await prisma.aiRun.create({ data });
  } catch (err) {
    // the audit row failing must not turn a good AI result into a failure —
    // but it is never silent
    console.error(`[aiRunLog] could not record ${data.kind} (${data.outcome}) for company ${data.companyId}: ${err.message}`);
    return null;
  }
}

/**
 * Runs `fn` (which makes the geminiClient call) and records it.
 * opts: { companyId, kind (a MODELS key), promptHash, input?, inputHash?, entityType?, entityId?, parentType?, parentId?, meta?, reason? }
 * The call runs inside an AI-ledger context (company, feature, entity, this
 * run's id), so every attempt geminiClient makes is tagged with them.
 * → { result, run } — `run` is the ai_runs row (or null when it couldn't be written).
 * A failing fn is recorded as `failed` and its error rethrown unchanged.
 */
export async function runLogged(opts, fn) {
  const model = MODELS[opts.kind];
  if (!model) throw new Error(`aiRunLog: unknown model kind "${opts.kind}"`);
  const base = {
    id: crypto.randomUUID(), // known before the call, so ledger rows can point at it
    companyId: opts.companyId,
    kind: opts.kind,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
    modelId: model.id,
    promptHash: opts.promptHash,
    inputHash: opts.inputHash ?? (opts.input !== undefined ? hashInput(opts.input) : null),
    reason: opts.reason ?? null,
  };
  const t0 = Date.now();
  const ledger = { companyId: opts.companyId, feature: FEATURE_BY_RUN_KIND[opts.kind], entityType: base.entityType, entityId: base.entityId, parentType: opts.parentType, parentId: opts.parentId, meta: opts.meta, aiRunId: base.id };
  return withAiContext(ledger, () => withGenerationMetrics(async () => {
    const usage = () => {
      const m = generationMetricsSnapshot() || {};
      return {
        calls: m.geminiCalls ?? 0,
        inputTokens: m.inputTokens ?? 0,
        outputTokens: m.outputTokens ?? 0,
        thinkingTokens: m.thinkingTokens ?? 0,
        cachedTokens: m.cachedTokens ?? 0,
        ms: Date.now() - t0,
      };
    };
    let result;
    try {
      result = await fn();
    } catch (err) {
      await writeRun({ ...base, ...usage(), outcome: "failed", error: String(err.message || err).slice(0, 2000) });
      throw err;
    }
    const run = await writeRun({ ...base, ...usage(), outcome: "ok" });
    return { result, run };
  }));
}

/** Records a call that was not made: outcome "disabled" (company setting) or "skipped" (nothing to ask). */
export function logNotRun({ companyId, kind, outcome, reason, entityType = null, entityId = null, promptHash = "-" }) {
  const model = MODELS[kind];
  return writeRun({ companyId, kind, entityType, entityId, modelId: model?.id || "-", promptHash, outcome, reason });
}
