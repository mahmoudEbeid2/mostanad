import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { runLogged, sha16, stableStringify } from "../ai/aiRunLog.js";
import { clampConfidence } from "../ai/aiSuggestions.js";
import { normKey, canonicalFull, isForbiddenKey } from "../paths/sourcePath.js";
import { verifyAnswer } from "./evidenceVerifier.js";

// Gap resolution (plan.md §6.1, Phase A2): ONE CERT_INVOICE_GAPS call per
// invoice for every gap code could not fill. The model may only POINT at
// where a value is written — a quote of the invoice text, a path in the
// matched product, or a quote inside a product text — and code verifies each
// pointer (evidenceVerifier, P2). A product path's value is read by code (P1).
// This file builds the prompt, calls the model and verifies; the caller
// (dataNeedsService) stores the outcome.

const MAX_PRODUCT_JSON = 8192; // per product (plan.md §6.1)
const MAX_EMPTY_PATHS = 60;
const MAX_NEAR_MISSES = 8;
const TEXT_SKIP = new Set(["id", "companyId", "categoryId", "brandId"]);

const INSTRUCTIONS = [
  "You fill gaps in certificate data from an invoice and the company's product data.",
  "For every gap say whether its value is WRITTEN somewhere you were given, and point at it. Never compute, convert, translate or guess a value.",
  "Evidence (at least one entry when found):",
  "- invoice_text: `quote` = an exact passage copied from the invoice text (a few words around the value, as printed), `page` = its page number;",
  "  a line-level gap (scope \"line\") must be quoted from THAT line's own row/block of the invoice, never from another line;",
  "- product_path: `path` = a path in the gap's product JSON (e.g. specifications.values[\"PH value\"]) whose value IS the answer — use it when the product holds the value under a differently named key;",
  "- product_json_text: `path` = a product path holding free text and `quote` = the exact passage of that text containing the value.",
  "`value`: the value exactly as written inside the quote/path. found=false when it is not written anywhere you were given.",
  "confidence 0–1. note: one short sentence.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gapId: { type: "string" },
          found: { type: "boolean" },
          value: { type: "string", nullable: true },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["invoice_text", "product_path", "product_json_text"] },
                quote: { type: "string", nullable: true },
                page: { type: "integer", nullable: true },
                path: { type: "string", nullable: true },
              },
              required: ["type"],
            },
          },
          confidence: { type: "number" },
          note: { type: "string", nullable: true },
        },
        required: ["gapId", "found", "confidence"],
      },
    },
  },
  required: ["gaps"],
};

export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
const defaultGenerate = (args) => geminiClient.generateJson(args);

const truncate = (v) => {
  const s = JSON.stringify(v);
  return s.length > MAX_PRODUCT_JSON ? `${s.slice(0, MAX_PRODUCT_JSON)}…` : s;
};

/** Every leaf path (strings/numbers) of a JSON value, spelled in the path grammar, relative to `base`. */
function leafPaths(value, base, out = [], depth = 0) {
  if (depth > 6 || out.length > 400) return out;
  if (Array.isArray(value)) value.forEach((v, i) => leafPaths(v, `${base}[${i}]`, out, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue;
      leafPaths(v, /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(k) ? `${base}.${k}` : `${base}["${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`, out, depth + 1);
    }
  } else if (["string", "number"].includes(typeof value) && String(value).trim()) out.push({ path: base, value: String(value).slice(0, 80) });
  return out;
}

const words = (s) =>
  String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/**
 * Near-miss keys for a wanted product path (plan.md §6.1): leaves of the
 * product whose last key shares a word with the wanted key, or equals it
 * ignoring case/space/punctuation ("PH value" for "pH").
 */
export function nearMisses(product, wantedPath, jsonColumns) {
  const last = String(wantedPath || "").match(/(?:\.|\["?)([^."[\]]+)"?\]?$/)?.[1] || "";
  const want = new Set(words(last));
  const wantNorm = normKey(last).replace(/[^\p{L}\p{N}]/gu, "");
  const hits = [];
  for (const col of jsonColumns) {
    if (product?.[col] === null || product?.[col] === undefined) continue;
    for (const leaf of leafPaths(product[col], col)) {
      const key = leaf.path.match(/(?:\.|\["?)([^."[\]]+)"?\]?$/)?.[1] || "";
      const kn = normKey(key).replace(/[^\p{L}\p{N}]/gu, "");
      if (`product.${leaf.path}` === wantedPath) continue;
      if ((wantNorm && kn.includes(wantNorm)) || words(key).some((w) => want.has(w))) hits.push({ path: leaf.path, value: leaf.value });
    }
  }
  return hits.slice(0, MAX_NEAR_MISSES);
}

/**
 * Builds the prompt payload.
 * gaps: [{ gapId, fieldKey, label, category, expectedType, dateFormat?, scope, lineNo?, productRef?, wantedPath? }]
 * products: Map(productRef → { product, emptyPaths, nearMisses })
 */
export function buildPayload({ invoice, items, gaps, products, jsonColumns }) {
  return {
    invoice: { header: invoice.header || {}, lines: items.map((it) => ({ lineNo: it.lineNo, ...(it.data || {}), productRef: it.productRef || null })) },
    products: [...products].map(([ref, p]) => ({
      productRef: ref,
      name: p.product.name,
      emptyPaths: p.emptyPaths.slice(0, MAX_EMPTY_PATHS),
      nearMisses: p.nearMisses,
      json: Object.fromEntries(jsonColumns.filter((c) => p.product[c] !== null && p.product[c] !== undefined).map((c) => [c, truncate(p.product[c])])),
      // the product's own text columns too: a value may be written inside one (product_json_text)
      text: truncate(Object.fromEntries(Object.entries(p.product).filter(([k, v]) => typeof v === "string" && v.trim() && !TEXT_SKIP.has(k)))),
    })),
    gaps,
  };
}

/**
 * Asks the model once and verifies every answer.
 * input: { companyId, invoiceId, textContent, payload, gapCtx: Map(gapId → verify ctx) }
 * → { answers: Map(gapId → { answer, verdict }), run, inputHash }
 * Throws the model's error unchanged (the caller degrades, P8).
 */
export async function askGaps({ companyId, invoiceId, textContent, payload, gapCtx }, { generate = defaultGenerate } = {}) {
  // large shared content first (CLAUDE.md prompt order): instructions → invoice text → products → gaps
  const contents = [
    INSTRUCTIONS,
    `Invoice text:\n${textContent || "(no stored text)"}`,
    `Invoice (extracted) and matched products:\n${JSON.stringify({ invoice: payload.invoice, products: payload.products })}`,
    `Gaps:\n${JSON.stringify(payload.gaps)}`,
  ];
  const inputHash = sha16(stableStringify({ textContent, payload }));
  const { result, run } = await runLogged(
    { companyId, kind: "CERT_INVOICE_GAPS", promptHash: PROMPT_HASH, inputHash, entityType: "invoice", entityId: invoiceId, reason: `${payload.gaps.length} gap(s) code could not fill` },
    () => generate({ model: MODELS.CERT_INVOICE_GAPS.id, temperature: MODELS.CERT_INVOICE_GAPS.temperature, thinkingBudget: MODELS.CERT_INVOICE_GAPS.thinkingBudget, contents, schema: RESPONSE_SCHEMA, maxOutputTokens: 8192 })
  );
  const answers = new Map();
  for (const g of payload.gaps) {
    const answer = (result?.gaps || []).find((a) => a?.gapId === g.gapId) || null;
    if (!answer) {
      answers.set(g.gapId, { answer: null, verdict: { verified: false, checks: [], reason: "the AI gave no answer for this gap" } });
      continue;
    }
    const clean = { ...answer, confidence: clampConfidence(answer.confidence), value: answer.value === null || answer.value === undefined ? null : String(answer.value).slice(0, 500) };
    const verdict = verifyAnswer(clean, gapCtx.get(g.gapId));
    // a product path other than the one the template maps is a near miss the user may adopt as a synonym
    if (verdict.verified && verdict.provenance?.kind === "product_path" && g.wantedPath) {
      const alt = canonicalFull(verdict.provenance.path);
      if (alt && alt !== canonicalFull(g.wantedPath)) verdict.provenance.nearMiss = { canonical: canonicalFull(g.wantedPath), alternative: alt };
    }
    answers.set(g.gapId, { answer: clean, verdict });
  }
  return { answers, run, inputHash };
}
