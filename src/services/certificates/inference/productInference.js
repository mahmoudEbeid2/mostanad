import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { runLogged, sha16, stableStringify } from "../ai/aiRunLog.js";
import { clampConfidence } from "../ai/aiSuggestions.js";
import { resolve, isForbiddenKey } from "../paths/sourcePath.js";
import { productJsonColumns } from "../templates/sourceCatalogue.js";
import { normalizeEvidence } from "../dataNeeds/evidenceVerifier.js";
import { DERIVATIONS, verifyDerived } from "./derivations.js";
import { allowsInference } from "./policy.js";

// Tier I (plan.md §14.2, A5): a product fact a certificate needs, still missing
// after A2, inferred from the product's OWN complete record. ONE
// CERT_PRODUCT_INFER call per invoice. The model must either quote the value
// verbatim from a product field ("quoted") or name an allow-listed derivation
// of quoted inputs ("derived") that CODE re-runs and must reproduce — both are
// facts, filled directly. Since the owner's 2026-10-24 decision a third answer
// is accepted: "estimate" — a value inferred from facts of THIS product, each
// quoted verbatim; it is filled marked estimated and a person confirms it. Fields whose policy forbids
// inference never reach the prompt, and an answer for one is ignored anyway.

const MAX_PRODUCT_JSON = 16384;
const SKIP = new Set(["id", "companyId", "categoryId", "brandId", "createdAt", "updatedAt"]);

const INSTRUCTIONS = [
  "You fill missing certificate values for a product from the product's OWN record only. Never use outside knowledge.",
  "For each gap, either:",
  "- derivation \"quoted\": the value is written in a product field. evidence = [{ path, quote }] where path is the field's path in the record (e.g. storage, specifications.values[\"Shelf life\"]) and quote is an exact passage of that field containing the value; or",
  "- derivation \"derived\": the value is a deterministic transformation of quoted facts, and derivationKind is one of:",
  "  unit_conversion (params.to = target unit, e.g. \"mg/L\"; the quote must be exactly the quantity, e.g. \"120 g/L\"),",
  "  select_from_list (evidence path = a list field; the value is one item of it),",
  "  join_list (evidence path = a list field; params.fields = the keys to print for object items, params.separator),",
  "  normalize_case (params.case = upper|lower|title; the quote is exactly the input text).",
  "- derivation \"estimate\": the value is NOT written in the record but follows from facts that are (e.g. appearance from the form and the ingredients).",
  "  evidence = every fact you used, each [{ path, quote }] with an exact quote; reasoning = how the value follows from them. It is shown to a person as an estimate to confirm.",
  "  Never estimate from what such products usually are without a fact of THIS product; then answer found=false.",
  "confidence 0–1; reasoning: one short sentence.",
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
          derivation: { type: "string", enum: ["quoted", "derived", "estimate"], nullable: true },
          derivationKind: { type: "string", enum: DERIVATIONS, nullable: true },
          params: {
            type: "object",
            nullable: true,
            properties: { to: { type: "string", nullable: true }, case: { type: "string", nullable: true }, separator: { type: "string", nullable: true }, fields: { type: "array", nullable: true, items: { type: "string" } } },
          },
          evidence: { type: "array", items: { type: "object", properties: { path: { type: "string" }, quote: { type: "string", nullable: true } }, required: ["path"] } },
          reasoning: { type: "string", nullable: true },
          confidence: { type: "number" },
        },
        required: ["gapId", "found", "confidence"],
      },
    },
  },
  required: ["gaps"],
};
export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
const defaultGenerate = (args) => geminiClient.generateJson({ ...args, ledger: { feature: "certificates.inference" } });

/** The product's complete record for the prompt (§14.2 input): every column, JSON ≤ 16 KB, category, brand. */
export function productRecord(product) {
  const json = new Set(productJsonColumns());
  const out = {};
  for (const [k, v] of Object.entries(product || {})) {
    if (SKIP.has(k) || isForbiddenKey(k) || v === null || v === undefined || v === "") continue;
    if (k === "category" || k === "brand") {
      if (v?.name) out[k] = { name: v.name };
      continue;
    }
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  let s = JSON.stringify(out);
  if (s.length > MAX_PRODUCT_JSON) {
    for (const c of json) if (out[c] !== undefined) out[c] = JSON.stringify(out[c]).slice(0, 4000);
    s = JSON.stringify(out);
  }
  return s.length > MAX_PRODUCT_JSON ? JSON.parse(JSON.stringify(out, (k, v) => (typeof v === "string" && v.length > 1500 ? `${v.slice(0, 1500)}…` : v))) : out;
}

const scalar = (v) => ["string", "number"].includes(typeof v);

/**
 * Verifies one tier-I answer against the product (pure). → { ok, value, provenance } | { ok: false, reason }
 */
export function verifyInference(answer, product) {
  if (!answer?.found) return { ok: false, reason: "not found" };
  const value = String(answer.value ?? "").trim();
  if (!value) return { ok: false, reason: "no value" };
  const evidence = (Array.isArray(answer.evidence) ? answer.evidence : []).slice(0, 4);
  if (!evidence.length) return { ok: false, reason: "no evidence" };
  const checked = [];
  for (const ev of evidence) {
    const r = resolve({ product }, `product.${String(ev?.path || "").replace(/^product\./, "")}`);
    if (r.error || !r.found) return { ok: false, reason: `the product has nothing at “${ev?.path}”` };
    const quote = ev.quote ? String(ev.quote).trim() : null;
    if (quote) {
      const hay = scalar(r.value) ? String(r.value) : JSON.stringify(r.value);
      if (!normalizeEvidence(hay).includes(normalizeEvidence(quote))) return { ok: false, reason: `the quote is not in ${r.path}` };
    }
    checked.push({ path: r.path, quote, value: r.value });
  }
  if (answer.derivation === "quoted") {
    const inQuote = checked.some((c) => (c.quote && normalizeEvidence(c.quote).includes(normalizeEvidence(value))) || (scalar(c.value) && normalizeEvidence(String(c.value)) === normalizeEvidence(value)));
    if (!inQuote) return { ok: false, reason: "the value is not inside the quoted product text" };
    return { ok: true, value, provenance: { tier: "I", kind: "product_inference", derivation: "quoted", evidence: checked.map(({ path, quote }) => ({ path, quote })) } };
  }
  if (answer.derivation === "derived") {
    const kind = answer.derivationKind;
    const first = checked[0];
    const input = ["select_from_list", "join_list"].includes(kind) ? first.value : first.quote ?? (scalar(first.value) ? String(first.value) : null);
    const v = verifyDerived(kind, input, answer.params || {}, value);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, value: v.computed, provenance: { tier: "I", kind: "product_inference", derivation: "derived", derivationKind: kind, params: answer.params || {}, evidence: checked.map(({ path, quote }) => ({ path, quote })) } };
  }
  if (answer.derivation === "estimate") {
    // an estimate: no verifiable value, but every fact it rests on is a verified quote of this product
    const basis = String(answer.reasoning || "").trim();
    if (!basis) return { ok: false, reason: "an estimate needs its reasoning" };
    if (!checked.every((c) => c.quote)) return { ok: false, reason: "every fact of an estimate needs an exact quote" };
    return { ok: true, value, estimated: true, provenance: { tier: "I", kind: "product_inference", derivation: "estimate", estimated: true, estimateBasis: basis.slice(0, 300), evidence: checked.map(({ path, quote }) => ({ path, quote })) } };
  }
  return { ok: false, reason: "derivation must be quoted, derived or estimate" };
}

/**
 * gaps: [{ gapId, field, label, expectedType, dateFormat?, product }]
 * → { answers: Map(gapId → { answer, verdict }), run, inputHash } — throws the model's error (caller degrades).
 */
export async function askInference({ companyId, invoiceId, gaps }, { generate = defaultGenerate } = {}) {
  const allowed = gaps.filter((g) => allowsInference(g.field)); // §14.1: never-fields never reach the prompt
  const refs = new Map();
  for (const g of allowed) if (!refs.has(g.product.id)) refs.set(g.product.id, `P${refs.size + 1}`);
  const payload = {
    products: [...refs].map(([id, ref]) => ({ productRef: ref, record: productRecord(allowed.find((g) => g.product.id === id).product) })),
    gaps: allowed.map((g) => ({ gapId: g.gapId, label: g.label, expectedType: g.expectedType, ...(g.dateFormat ? { dateFormat: g.dateFormat } : {}), productRef: refs.get(g.product.id) })),
  };
  const inputHash = sha16(stableStringify(payload));
  const { result, run } = await runLogged(
    { companyId, kind: "CERT_PRODUCT_INFER", promptHash: PROMPT_HASH, inputHash, entityType: "invoice", entityId: invoiceId, reason: `${allowed.length} product fact(s) still missing` },
    () => generate({ model: MODELS.CERT_PRODUCT_INFER.id, temperature: MODELS.CERT_PRODUCT_INFER.temperature, thinkingBudget: MODELS.CERT_PRODUCT_INFER.thinkingBudget, contents: [INSTRUCTIONS, `Products:\n${JSON.stringify(payload.products)}`, `Gaps:\n${JSON.stringify(payload.gaps)}`], schema: RESPONSE_SCHEMA, maxOutputTokens: 8192 })
  );
  const answers = new Map();
  for (const g of allowed) {
    const raw = (result?.gaps || []).find((a) => a?.gapId === g.gapId);
    if (!raw) continue;
    const answer = { ...raw, confidence: clampConfidence(raw.confidence), reasoning: raw.reasoning ? String(raw.reasoning).slice(0, 300) : null };
    answers.set(g.gapId, { answer, verdict: verifyInference(answer, g.product) });
  }
  return { answers, run, inputHash, sent: allowed.map((g) => g.gapId) };
}
