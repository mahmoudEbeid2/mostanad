import AppError from "../../../utils/appError.js";
import { prisma } from "../../../lib/prisma.js";
import { generate } from "../generation/labelGenerator.js";
import { selectReferences } from "../retrieval/referenceSelector.js";
import { getApprovedRulesForCountry } from "../regulatory/regulatoryDocumentService.js";
import { diff as diffLabelData } from "../versioning/versionService.js";

// §14.7 — deterministic replay. Re-runs generation against the label's frozen
// productProfile and reports whether the output still matches, plus whether
// the promptHash (Invariant #3) is even identical before asking "did the
// model drift" at all.
//
// HONEST LIMITATION: this re-selects references and re-fetches approved rules
// as they stand RIGHT NOW, not as they stood at original generation time —
// there is no frozen snapshot of the exact reference/rule rows used (only
// their ids, on `referenceLabelIds`/`regulatoryDocIds`). A drifted result can
// legitimately mean either (a) real model non-determinism, or (b) the
// reference/rule set changed since. `referenceSetDrifted`/`ruleSetDrifted`
// let the caller tell those apart before blaming the model. A true frozen
// re-run (using the exact same reference/rule ROWS, not just current ones)
// would require snapshotting full reference/rule content onto the label at
// generation time — deferred, flagged in PROGRESS.md as a "needs a decision"
// item since it duplicates data CLAUDE.md would otherwise want single-sourced.
// Pure — set-equality on two id arrays, order-insensitive.
export function idSetsDiffer(a = [], b = []) {
  const sortedA = JSON.stringify([...a].sort());
  const sortedB = JSON.stringify([...b].sort());
  return sortedA !== sortedB;
}

// Pure — the plain-language read on a computed replay result, factored out so
// it's testable without a live label/DB/AI call.
export function interpretReplay({ fieldsDiffered, referenceSetDrifted, ruleSetDrifted }) {
  if (fieldsDiffered.length === 0) return "Output is identical to the stored label.";
  if (referenceSetDrifted || ruleSetDrifted) {
    return "Reference or rule set has changed since original generation — a difference here is expected and does not by itself indicate model drift.";
  }
  return "Reference and rule sets are unchanged, yet output differs — this points to real model non-determinism, not stale inputs.";
}

export async function replay(labelId, { companyId } = {}) {
  const label = await prisma.generatedLabel.findFirst({
    where: { id: labelId, ...(companyId ? { companyId } : {}) },
  });
  if (!label) throw new AppError("Label not found", 404);
  if (!label.productProfile) {
    throw new AppError("This label has no stored productProfile (generated before Phase 4) — replay is not possible.", 422);
  }

  const profile = label.productProfile;
  const [rankedReferences, rules] = await Promise.all([
    selectReferences(profile),
    getApprovedRulesForCountry(label.country),
  ]);

  const regenerated = await generate({ profile, rankedReferences, rules });

  const referenceSetDrifted = idSetsDiffer(label.referenceLabelIds, regenerated.referenceLabelIds);
  const currentRuleDocIds = [...new Set(rules.map((r) => r.documentId))];
  const ruleSetDrifted = idSetsDiffer(label.regulatoryDocIds, currentRuleDocIds);

  const fieldsDiffered = diffLabelData(label.labelData, regenerated.labelData);
  const promptHashMatches = label.generationMeta?.promptHash != null
    ? label.generationMeta.promptHash === regenerated.generationMeta.promptHash
    : null; // null = original row predates promptHash (Phase 9) — not comparable

  return {
    identical: fieldsDiffered.length === 0,
    fieldsDiffered,
    promptHashMatches,
    referenceSetDrifted,
    ruleSetDrifted,
    originalGenerationMeta: label.generationMeta,
    regeneratedGenerationMeta: regenerated.generationMeta,
    interpretation: interpretReplay({ fieldsDiffered, referenceSetDrifted, ruleSetDrifted }),
  };
}
