import { prisma } from "../../../lib/prisma.js";
import { SUGGESTION_KINDS } from "../ai/aiSuggestions.js";

// The evaluation dashboard (plan.md §9, A4): how the certificate AI is doing
// for one company, from its own audit rows (ai_suggestions, ai_runs):
//   per suggestion kind — acceptance rate, edit rate, average confidence;
//   calibration — confidence buckets vs how often a person kept the answer;
//   calls — per model kind, and per template / per invoice per week (should
//           fall as mapping memory and aliases grow);
//   cost — an ESTIMATE from the token counts the provider reported.
// "Correct" = accepted or auto-accepted; "wrong" = edited or rejected (a pick
// code refused counts as wrong). Pending suggestions are not judged.

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : d);
/** USD per 1M tokens; defaults = Gemini 2.5 Flash list prices. Thinking tokens bill as output. */
export const prices = () => ({
  inputPerM: num(process.env.CERT_AI_PRICE_INPUT_PER_M, 0.3),
  outputPerM: num(process.env.CERT_AI_PRICE_OUTPUT_PER_M, 2.5),
  cachedPerM: num(process.env.CERT_AI_PRICE_CACHED_PER_M, 0.075),
});
export function costUsd({ inputTokens = 0, outputTokens = 0, thinkingTokens = 0, cachedTokens = 0 }, p = prices()) {
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * p.inputPerM + cachedTokens * p.cachedPerM + (outputTokens + thinkingTokens) * p.outputPerM) / 1e6;
}

const BUCKETS = [
  [0, 0.5, "< 0.50"],
  [0.5, 0.7, "0.50–0.69"],
  [0.7, 0.9, "0.70–0.89"],
  [0.9, 1.01, "≥ 0.90"],
];
const CORRECT = ["accepted", "auto_accepted"];
const WRONG = ["edited", "rejected"];
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
// the entity a call works for: templates for field mapping, invoices for the rest
const PER = { CERT_FIELD_MAP: "template", INVOICE_EXTRACT: "invoice", CERT_INVOICE_GAPS: "invoice", CERT_PRODUCT_MATCH: "invoice" };

/** GET /certificate-ai-stats?days= */
export async function aiStats(companyId, { days = 90 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 90, 1), 730) * 86_400_000);
  const [suggestions, runs] = await Promise.all([
    prisma.aiSuggestion.findMany({ where: { companyId, createdAt: { gte: since } }, select: { kind: true, status: true, confidence: true, decidedByUserId: true } }),
    prisma.aiRun.findMany({ where: { companyId, createdAt: { gte: since } }, select: { kind: true, outcome: true, entityType: true, entityId: true, inputTokens: true, outputTokens: true, thinkingTokens: true, cachedTokens: true, ms: true, createdAt: true } }),
  ]);

  const kinds = SUGGESTION_KINDS.map((kind) => {
    const s = suggestions.filter((x) => x.kind === kind);
    const n = (st) => s.filter((x) => x.status === st).length;
    const decided = s.filter((x) => [...CORRECT, ...WRONG].includes(x.status)).length;
    return {
      kind,
      total: s.length,
      pending: n("pending"),
      accepted: n("accepted"),
      autoAccepted: n("auto_accepted"),
      edited: n("edited"),
      rejected: n("rejected"),
      refusedByCode: s.filter((x) => x.status === "rejected" && !x.decidedByUserId).length,
      acceptanceRate: rate(n("accepted") + n("auto_accepted"), decided),
      editRate: rate(n("edited"), decided),
      avgConfidence: s.length ? Math.round((s.reduce((a, x) => a + x.confidence, 0) / s.length) * 100) / 100 : null,
    };
  }).filter((k) => k.total);

  const calibration = BUCKETS.map(([lo, hi, label]) => {
    const d = suggestions.filter((x) => x.confidence >= lo && x.confidence < hi && [...CORRECT, ...WRONG].includes(x.status));
    const correct = d.filter((x) => CORRECT.includes(x.status)).length;
    return { bucket: label, decided: d.length, correct, correctRate: rate(correct, d.length) };
  });

  const p = prices();
  const byKind = new Map();
  for (const r of runs) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, { kind: r.kind, calls: 0, ok: 0, failed: 0, disabled: 0, skipped: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, ms: 0, costUsd: 0 });
    const k = byKind.get(r.kind);
    k[r.outcome] = (k[r.outcome] || 0) + 1;
    if (r.outcome === "ok" || r.outcome === "failed") {
      k.calls++;
      k.inputTokens += r.inputTokens;
      k.outputTokens += r.outputTokens;
      k.thinkingTokens += r.thinkingTokens;
      k.cachedTokens += r.cachedTokens;
      k.ms += r.ms;
      k.costUsd += costUsd(r, p);
    }
  }
  const runsView = [...byKind.values()].map((k) => ({ ...k, avgMs: k.calls ? Math.round(k.ms / k.calls) : null, costUsd: Math.round(k.costUsd * 1e6) / 1e6 }));

  // calls per template / per invoice, per week (plan.md §9: should fall as memory grows)
  const weekOf = (d) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); // Monday
    return x.toISOString().slice(0, 10);
  };
  const weeks = new Map();
  for (const r of runs) {
    const per = PER[r.kind];
    if (!per || !["ok", "failed"].includes(r.outcome)) continue;
    const key = `${weekOf(r.createdAt)}|${per}`;
    if (!weeks.has(key)) weeks.set(key, { week: weekOf(r.createdAt), per, calls: 0, entities: new Set(), costUsd: 0 });
    const w = weeks.get(key);
    w.calls++;
    if (r.entityId) w.entities.add(r.entityId);
    w.costUsd += costUsd(r, p);
  }
  const weekly = [...weeks.values()]
    .map((w) => ({ week: w.week, per: w.per, calls: w.calls, entities: w.entities.size, callsPerEntity: w.entities.size ? Math.round((w.calls / w.entities.size) * 100) / 100 : null, costUsd: Math.round(w.costUsd * 1e6) / 1e6 }))
    .sort((a, b) => a.week.localeCompare(b.week) || a.per.localeCompare(b.per));

  const totalCost = runsView.reduce((a, k) => a + k.costUsd, 0);
  return {
    since: since.toISOString(),
    kinds,
    calibration,
    runs: runsView,
    weekly,
    cost: { totalUsd: Math.round(totalCost * 1e6) / 1e6, prices: p, estimate: true },
  };
}
