import geminiClient from "../ai/geminiClient.js";
import { MODELS } from "../ai/modelRegistry.js";
import { prisma } from "../../lib/prisma.js";
import { withAiContext, currentAiContext } from "../ai/aiContext.js";
import { DOC_TYPES } from "./intakeRules.js";

// The last step of recognising a dropped file: asked only when the filename and
// text rules don't decide (no text layer, a name and a text that say nothing).
// The first pages only — as text, or the file itself when it has no text (a scan,
// a photo). Schema-constrained; every call goes to the AI cost ledger as
// feature "intake.classify" on the item. It names what the document IS and whose;
// it never reads batch numbers, dates or results (the rules read those, verbatim).

const SCHEMA = {
  type: "object",
  properties: {
    docType: { type: "string", enum: DOC_TYPES },
    certificateType: { type: "string", nullable: true, description: "COA, FSC, COO, COC, HC, GMP… when it is a certificate" },
    filled: { type: "boolean", description: "an issued certificate with real batch numbers / results / dates (true), or a blank design (false)" },
    companyName: { type: "string", nullable: true, description: "the company / manufacturer the document belongs to, as printed" },
    brandName: { type: "string", nullable: true },
    productNames: { type: "array", items: { type: "string" }, description: "product names exactly as printed" },
    country: { type: "string", nullable: true, description: "destination / market country, ISO alpha-2, only if printed" },
    confidence: { type: "number" },
    reason: { type: "string", description: "one short sentence: what on the page shows it" },
  },
  required: ["docType", "productNames", "confidence", "reason"],
};

const PROMPT = [
  "A veterinary / animal-feed company dropped this file into its document system. Say what it is:",
  "label (product label artwork), certificate_template (the company's own blank or design certificate), certificate_filled (an issued certificate or supplier COA with real batch numbers / results),",
  "invoice, manufacturing_order, catalogue (product catalogue), product_list (a table of products), or other.",
  "Copy names exactly as printed; leave a field null when the page doesn't show it. Never guess batch numbers, dates or results — they are not asked.",
].join("\n");

/**
 * item: { id, name, mimeType }, pages: [{ n, text }], buffer (used when there is no text).
 * → { docType, certCode, filled, companyName, brandName, productNames, country, confidence, reason }
 */
export async function classifyWithAi({ item, pages = [], buffer = null, companyId = null }) {
  const text = pages.slice(0, 2).map((p) => `=== Page ${p.n} ===\n${p.text}`).join("\n").slice(0, 8000);
  const contents = text.trim()
    ? [`${PROMPT}\n\nFile name: ${item.name}\n\n${text}`]
    : [{ role: "user", parts: [{ text: `${PROMPT}\n\nFile name: ${item.name}` }, { inlineData: { mimeType: item.mimeType || "application/pdf", data: buffer.toString("base64") } }] }];
  // the ledger row is the item's (its cost shows on the review card), in the drop's company
  const out = await withAiContext({ ...currentAiContext(), entityType: "intake_item", entityId: item.id, ...(companyId ? { companyId } : {}) }, () =>
    geminiClient.generateJson({
      ledger: { feature: "intake.classify" },
      model: MODELS.EXTRACT.id,
      temperature: 0,
      thinkingBudget: MODELS.EXTRACT.thinkingBudget,
      contents,
      schema: SCHEMA,
    })
  );
  return {
    docType: DOC_TYPES.includes(out?.docType) ? out.docType : "other",
    certCode: out?.certificateType ? String(out.certificateType).toUpperCase().slice(0, 6) : null,
    filled: !!out?.filled,
    companyName: out?.companyName || null,
    brandName: out?.brandName || null,
    productNames: (out?.productNames || []).map((n) => String(n).toUpperCase().trim()).filter(Boolean).slice(0, 20),
    country: out?.country ? String(out.country).toUpperCase().slice(0, 2) : null,
    confidence: Math.max(0, Math.min(1, Number(out?.confidence) || 0.5)),
    reason: String(out?.reason || "").slice(0, 200),
  };
}

/** What the ledger recorded for one item's AI calls → { calls, costUsd | null } */
export async function itemAiCost(itemId) {
  const rows = await prisma.aiCall.findMany({ where: { entityType: "intake_item", entityId: itemId }, select: { costUsd: true } }).catch(() => []);
  if (!rows.length) return { calls: 0, costUsd: 0 };
  return { calls: rows.length, costUsd: rows.some((r) => r.costUsd === null) ? null : rows.reduce((n, r) => n + Number(r.costUsd), 0) };
}
