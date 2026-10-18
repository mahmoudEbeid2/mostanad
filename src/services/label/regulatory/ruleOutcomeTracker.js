// §7b/c/d — statistical self-correction. Tracks raw pass/fail outcomes per
// (rule, discriminant combination) and auto-downgrades a rule from FAIL to
// NEEDS_REVIEW (via RegulatoryRule.autoDowngraded, read by ruleValidator's
// severity ceiling) when it fails an abnormally high proportion of labels of
// that SAME combination. Never deletes or disables a rule — downgrade only,
// and every downgrade is recorded on the rule row itself (ruleId, document,
// observed rate, sample size, timestamp), queryable through the existing
// GET /regulatory-rules endpoint.
import { prisma } from "../../../lib/prisma.js";

const STATISTICAL_FAILURE_THRESHOLD = Number(process.env.RULE_STATISTICAL_FAILURE_THRESHOLD) || 0.7;
const STATISTICAL_MIN_SAMPLE_SIZE = Number(process.env.RULE_STATISTICAL_MIN_SAMPLE_SIZE) || 20;

// Deterministic, sorted so the same discriminant map always serializes the
// same way regardless of key insertion order. "" (no discriminants) is a
// real, valid bucket — the general case.
export function serializeDiscriminants(discriminants) {
  const entries = Object.entries(discriminants || {}).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

const statusToOutcome = (status) => (status === "PASS" ? "pass" : ["FAIL", "WARN", "NEEDS_REVIEW"].includes(status) ? "fail" : null);

/**
 * rules: the RegulatoryRule[]-shaped array validationEngine.validate() was
 * given (needs .id/.ruleKey). verdicts: validate()'s output verdicts. Call
 * this right after persisting a ValidationReport for a fresh
 * validate(...) run — never for a re-display of an old report, or the same
 * outcome gets double-counted.
 */
export async function recordOutcomes(rules, verdicts, { labelId = null, discriminants = {} } = {}) {
  const discriminantKey = serializeDiscriminants(discriminants);
  const ruleByKey = new Map(rules.filter((r) => r.id && r.ruleKey).map((r) => [r.ruleKey, r]));

  for (const v of verdicts) {
    if (v.layer !== "regulatory_rule" || !v.ruleKey) continue;
    const rule = ruleByKey.get(v.ruleKey);
    if (!rule) continue;
    const outcome = statusToOutcome(v.status);
    if (!outcome) continue; // UNVERIFIABLE/NEEDS_CONFIRMATION aren't a pass/fail signal about the rule itself

    await prisma.ruleEvaluationOutcome.create({ data: { ruleId: rule.id, labelId, discriminantKey, status: outcome } });
    await maybeDowngradeRule(rule.id, discriminantKey);
  }
}

async function maybeDowngradeRule(ruleId, discriminantKey) {
  const rule = await prisma.regulatoryRule.findUnique({ where: { id: ruleId } });
  if (!rule || rule.autoDowngraded) return; // downgrade, never delete, never re-evaluate once downgraded (§7d)

  const outcomes = await prisma.ruleEvaluationOutcome.findMany({ where: { ruleId, discriminantKey } });
  if (outcomes.length < STATISTICAL_MIN_SAMPLE_SIZE) return;

  const failures = outcomes.filter((o) => o.status === "fail").length;
  const failureRate = failures / outcomes.length;
  if (failureRate < STATISTICAL_FAILURE_THRESHOLD) return;

  await prisma.regulatoryRule.update({
    where: { id: ruleId },
    data: {
      autoDowngraded: true,
      downgradeReason: `Statistically downgraded: ${failures}/${outcomes.length} (${(failureRate * 100).toFixed(1)}%) of labels with discriminant combination "${discriminantKey || "(none)"}" failed this rule — a real rule fails some products, not nearly all of them; near-total failure more likely means the rule was misread.`,
      downgradedAt: new Date(),
      observedFailureRate: failureRate,
      observedSampleSize: outcomes.length,
    },
  });
}
