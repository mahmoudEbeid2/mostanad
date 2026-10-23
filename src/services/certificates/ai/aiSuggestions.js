import { prisma } from "../../../lib/prisma.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { initialStatus } from "./aiSettings.js";

// AiSuggestion rows (plan.md §4, P7): every AI proposal, accepted or not, with
// full provenance — the audit trail and the data the A4 evaluation reads.
// The layers (A1–A3) create them through recordSuggestion(); a person's
// decision goes through decideSuggestion().

export const SUGGESTION_KINDS = ["field_map", "field_label", "invoice_gap", "product_match", "dictionary_synonym", "group_binding", "product_infer", "web_lookup"];
export const ENTITY_TYPES = ["template_field", "invoice_item", "certificate_field", "product", "dictionary_entry"];
export const DECISIONS = ["accepted", "edited", "rejected"];

export const clampConfidence = (c) => (typeof c === "number" && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0);

/**
 * s: { companyId, kind, entityType, entityId, proposal, evidence?, evidenceVerified?,
 *      confidence, modelKind (a MODELS key), promptHash, inputHash, dictionaryVersion?, aiRunId? }
 * settings: the company's AI settings (status: plan.md P4).
 */
export async function recordSuggestion(s, settings) {
  if (!SUGGESTION_KINDS.includes(s.kind)) throw new Error(`unknown suggestion kind "${s.kind}"`);
  if (!ENTITY_TYPES.includes(s.entityType)) throw new Error(`unknown entity type "${s.entityType}"`);
  const model = MODELS[s.modelKind];
  if (!model) throw new Error(`unknown model kind "${s.modelKind}"`);
  const confidence = clampConfidence(s.confidence);
  const evidenceVerified = s.evidenceVerified ?? null;
  return prisma.aiSuggestion.create({
    data: {
      companyId: s.companyId,
      kind: s.kind,
      entityType: s.entityType,
      entityId: s.entityId,
      proposal: s.proposal,
      evidence: s.evidence ?? undefined,
      evidenceVerified,
      confidence,
      status: initialStatus(settings, { confidence, evidenceVerified }),
      modelId: model.id,
      promptHash: s.promptHash,
      inputHash: s.inputHash,
      dictionaryVersion: s.dictionaryVersion ?? null,
      aiRunId: s.aiRunId ?? null,
    },
  });
}

/** A person's decision on a pending suggestion (tenant-scoped). */
export async function decideSuggestion(companyId, id, { decision, finalValue = null, userId = null }) {
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  const { count } = await prisma.aiSuggestion.updateMany({
    where: { id, companyId, status: { in: ["pending", "auto_accepted"] } },
    data: { status: decision, finalValue: finalValue ?? undefined, decidedByUserId: userId, decidedAt: new Date() },
  });
  return count === 1;
}
