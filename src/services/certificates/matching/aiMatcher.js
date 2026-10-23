import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { prisma } from "../../../lib/prisma.js";
import { aiAllowed } from "../ai/aiSettings.js";
import { runLogged, logNotRun, sha16, stableStringify } from "../ai/aiRunLog.js";
import { recordSuggestion, clampConfidence } from "../ai/aiSuggestions.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";

// AI product matching (plan.md §7 step 5, Phase A3): ONE CERT_PRODUCT_MATCH
// call per invoice, only for the lines code left ambiguous. The model may only
// pick one of the candidates code gave it (or none). Code then checks that the
// pick is a candidate of that line and the company's product, and lowers the
// confidence when the invoice contradicts the product (pack size, strength %).
// A line whose (text, candidates) were already answered reuses that answer —
// re-matching never calls the model again.

const INSTRUCTIONS = [
  "You match commercial-invoice lines to a company's product catalogue.",
  "For every line choose the ONE candidate that is the same product (same product, pack size and strength), copying its id exactly,",
  "or productId null when no candidate is clearly the same product — e.g. two candidates differ only by strength and the line doesn't say which.",
  "Never choose a product that is not in that line's candidates.",
  "confidence 0–1; reasons: short phrases (what matches, what differs).",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lineNo: { type: "integer" },
          productId: { type: "string", nullable: true },
          confidence: { type: "number" },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["lineNo", "confidence"],
      },
    },
  },
  required: ["lines"],
};

export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
export const AI_CANDIDATES = 10;
const CONTRADICTION_FACTOR = 0.5;
const defaultGenerate = (args) => geminiClient.generateJson(args);

// ── contradiction checks (code) ──────────────────────────────────────────────
const UNIT = { kg: ["g", 1000], kgs: ["g", 1000], g: ["g", 1], gr: ["g", 1], grs: ["g", 1], gm: ["g", 1], gms: ["g", 1], gram: ["g", 1], grams: ["g", 1], mg: ["g", 0.001], l: ["ml", 1000], lt: ["ml", 1000], ltr: ["ml", 1000], litre: ["ml", 1000], liter: ["ml", 1000], ml: ["ml", 1] };

/** Pack sizes written in a text → ["g:1000", "ml:500"] (1 KG = 1000 g; 5 LT = 5000 ml). */
export function sizesOf(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/(\d+(?:[.,]\d+)?)\s*(kgs?|grams?|grs?|gms?|g|mg|ltr|lt|litre|liter|l|ml)(?![\p{L}])/giu)) {
    const [base, f] = UNIT[m[2].toLowerCase()];
    if (m[2].toLowerCase() === "mg") continue; // mg is a strength, not a pack size
    out.add(`${base}:${Math.round(Number(m[1].replace(",", ".")) * f * 1000) / 1000}`);
  }
  return [...out];
}

/** Strength percentages → ["20", "4.8"] */
export const percentsOf = (text) => [...new Set([...String(text || "").matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => String(Number(m[1].replace(",", ".")))))];

const showSize = (s) => {
  const [u, n] = s.split(":");
  const v = Number(n);
  return u === "g" ? (v >= 1000 ? `${v / 1000} KG` : `${v} G`) : v >= 1000 ? `${v / 1000} L` : `${v} ML`;
};

/**
 * Does the invoice line contradict the product? (plan.md §7 code checks)
 * line: { name, packing, extra } · product: { name, packaging, strength }
 * → [reason] (empty = no contradiction)
 */
export function contradictions(line, product) {
  const lineText = [line?.name, line?.packing, ...Object.values(line?.extra || {})].filter(Boolean).join(" ");
  const out = [];
  const ls = sizesOf(lineText);
  const ps = sizesOf([product?.packaging, product?.name].filter(Boolean).join(" "));
  const comparable = ls.filter((s) => ps.some((p) => p.split(":")[0] === s.split(":")[0]));
  if (comparable.length && !comparable.some((s) => ps.includes(s))) out.push(`invoice says ${comparable.map(showSize).join("/")}, product is ${ps.map(showSize).join("/")}`);
  const lp = percentsOf(lineText);
  const pp = percentsOf([product?.strength, product?.name].filter(Boolean).join(" "));
  if (lp.length && pp.length && !lp.some((x) => pp.includes(x))) out.push(`invoice says ${lp.join("/")} %, product is ${pp.join("/")} %`);
  return out;
}

const keyFacts = (p) => Object.fromEntries(Object.entries({ form: p.dosageForm || p.physicalForm, strength: p.strength, species: p.targetSpecies?.length ? p.targetSpecies.join(", ") : null }).filter(([, v]) => v));

/**
 * pending: [{ item, candidates: [productId…] }] — lines code left ambiguous.
 * products: Map(id → product row of THIS company).
 * → { picks: Map(itemId → { suggestion, productId, confidence, reasons, autoAccepted }), ai: { used, calls, reused, unavailable?, reason? } }
 */
export async function aiMatch(invoice, pending, products, settings, { generate = defaultGenerate } = {}) {
  const ai = { used: false, calls: 0, reused: 0, asked: 0 };
  const picks = new Map();
  if (!pending.length) return { picks, ai };
  const lineOf = (it) => ({ lineNo: it.lineNo, name: it.data?.name || null, code: it.data?.code || null, packing: it.data?.packing || null, extra: it.data?.extra || {} });
  const candView = (id) => {
    const p = products.get(id);
    return { id, name: p.name, code: p.productCode || null, packaging: p.packaging || null, brand: p.brand?.name || null, keyFacts: keyFacts(p) };
  };
  const hashOf = (x) => sha16(stableStringify({ line: lineOf(x.item), candidates: x.candidates }));

  // 1. a line already answered for exactly this text and these candidates → reuse (0 calls)
  const ask = [];
  for (const x of pending) {
    const prev = await prisma.aiSuggestion.findFirst({ where: { companyId: invoice.companyId, kind: "product_match", entityType: "invoice_item", entityId: x.item.id, inputHash: hashOf(x) }, orderBy: { createdAt: "desc" } });
    if (prev) {
      ai.reused++; // answered before (a pick, "none", or a refused pick) — never paid for twice
      if (prev.proposal?.productId && ["pending", "auto_accepted"].includes(prev.status)) picks.set(x.item.id, { suggestion: prev, productId: prev.proposal.productId, confidence: prev.confidence, reasons: prev.proposal.reasons || [], autoAccepted: prev.status === "auto_accepted" });
    } else ask.push(x);
  }
  if (!ask.length) return { picks, ai };
  if (!aiAllowed(settings, "allowAiMatching")) {
    ai.unavailable = true;
    ai.reason = settings.enabled ? "AI matching is turned off for this company" : "AI is turned off for this company";
    await logNotRun({ companyId: invoice.companyId, kind: "CERT_PRODUCT_MATCH", outcome: "disabled", reason: ai.reason, entityType: "invoice", entityId: invoice.id, promptHash: PROMPT_HASH });
    return { picks, ai };
  }
  const payload = { lines: ask.map((x) => ({ ...lineOf(x.item), candidates: x.candidates.map(candView) })) };
  let result;
  let run;
  try {
    ({ result, run } = await runLogged(
      { companyId: invoice.companyId, kind: "CERT_PRODUCT_MATCH", promptHash: PROMPT_HASH, input: payload, entityType: "invoice", entityId: invoice.id, reason: `${ask.length} line(s) code could not match with certainty` },
      () => generate({ model: MODELS.CERT_PRODUCT_MATCH.id, temperature: MODELS.CERT_PRODUCT_MATCH.temperature, thinkingBudget: MODELS.CERT_PRODUCT_MATCH.thinkingBudget, contents: [INSTRUCTIONS, `Lines:\n${JSON.stringify(payload)}`], schema: RESPONSE_SCHEMA, maxOutputTokens: 4096 })
    ));
  } catch (err) {
    // P8: the candidates stay; the user matches by hand; the lines are asked again next time
    ai.unavailable = true;
    ai.reason = publicAiError(err);
    return { picks, ai };
  }
  ai.used = true;
  ai.calls = 1;
  ai.asked = ask.length;
  for (const x of ask) {
    const answer = (result?.lines || []).find((a) => a?.lineNo === x.item.lineNo);
    if (!answer) continue;
    const reasons = (Array.isArray(answer.reasons) ? answer.reasons : []).map((r) => String(r).slice(0, 120)).slice(0, 6);
    let invalid = null;
    let confidence = clampConfidence(answer.confidence);
    let found = [];
    if (answer.productId) {
      if (!x.candidates.includes(answer.productId)) invalid = "the AI chose a product that is not one of this line's candidates";
      else if (!products.has(answer.productId)) invalid = "the product is not in this company's catalogue";
      else {
        found = contradictions(x.item.data, products.get(answer.productId));
        if (found.length) confidence *= CONTRADICTION_FACTOR;
      }
    }
    const proposal = { productId: invalid ? null : answer.productId || null, productName: !invalid && answer.productId ? products.get(answer.productId).name : null, reasons, contradictions: found, raw: answer };
    const suggestion = await recordSuggestion(
      { companyId: invoice.companyId, kind: "product_match", entityType: "invoice_item", entityId: x.item.id, proposal, confidence: invalid || !answer.productId ? 0 : confidence, modelKind: "CERT_PRODUCT_MATCH", promptHash: PROMPT_HASH, inputHash: hashOf(x), aiRunId: run?.id },
      settings
    );
    if (invalid) {
      await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: invalid } } });
      continue;
    }
    if (!answer.productId) continue; // "none of them" — stays for the user, remembered so it isn't asked again
    picks.set(x.item.id, { suggestion, productId: answer.productId, confidence, reasons: [...reasons, ...found.map((c) => `⚠ ${c}`)], autoAccepted: suggestion.status === "auto_accepted" });
  }
  return { picks, ai };
}
