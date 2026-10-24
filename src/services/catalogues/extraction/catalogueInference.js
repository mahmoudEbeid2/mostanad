import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { runLogged, sha16, stableStringify } from "../../certificates/ai/aiRunLog.js";

// Estimating what the catalogue does NOT print (owner rule, A6.3). Business
// requirement: a product gets its missing facts — but ONLY fields still empty
// after the catalogue, each stored apart as an estimate { value, basis, modelId,
// promptHash } (tier I, estimated: true), shown with an "Estimated" badge and
// never used in a certificate until a person confirms it (fieldProvenance).
//  - NEVER estimated (always empty unless printed): composition / ingredient
//    amounts, product code, specification values, registration number — and
//    the name, producer, origin, packaging and category (identity and
//    commercial facts the supplier states or doesn't).
//  - withdrawalPeriod may be estimated, and is always flagged for the admin.
//  - No hedging: a value is clean or absent. "likely …", "not specified",
//    "unknown", a question mark → dropped.
// One call per catalogue version; a failed call leaves the verified values only.

export const INFERABLE = ["description", "indications", "targetSpecies", "physicalForm", "appearance", "dosage", "mixingInstructions", "contraindications", "userSafety", "storage", "withdrawalPeriod"];
export const NEVER_INFERRED = ["name", "productCode", "activeIngredients", "specifications", "registrationNumber", "producer", "origin", "packaging", "category"];
export const FLAGGED_WHEN_ESTIMATED = new Set(["withdrawalPeriod"]);
const HEDGE = /\b(likely|probably|possibly|perhaps|presumably|maybe|may be|might|could be|not specified|not stated|not available|unspecified|unknown|unclear|assumed?|approximately|approx\.?|typically|usually|generally|estimated?|n\/a)\b|\?|\b(tbd|tbc)\b/i;

const INSTRUCTIONS = [
  "You complete missing product data for an animal-feed / veterinary product catalogue, from professional domain knowledge.",
  "For each product you get what its catalogue page states (`known`) and the fields it does NOT state (`missing`). Fill only `missing` fields that a professional can state with confidence for this kind of product; leave the rest out.",
  "Each value must be clean and final, as it would be printed on a product sheet — never hedged (no 'likely', 'probably', 'not specified', 'unknown', no question marks). If you can't state it cleanly, leave the field out.",
  "`basis`: ONE short sentence saying what the estimate rests on (e.g. 'Water-soluble vitamin premixes for drinking water are stored dry below 25 °C').",
  "targetSpecies: a comma-separated list. Never output composition, amounts, codes, specifications, registration numbers, producer, origin or packaging.",
].join("\n");

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          blockId: { type: "string" },
          estimates: {
            type: "array",
            items: { type: "object", properties: { field: { type: "string", enum: INFERABLE }, value: { type: "string" }, basis: { type: "string" } }, required: ["field", "value", "basis"] },
          },
        },
        required: ["blockId", "estimates"],
      },
    },
  },
  required: ["products"],
};
export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
const defaultGenerate = (args) => geminiClient.generateJson({ ...args, ledger: { feature: "catalogue.infer" } });

const isEmpty = (v) => v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : !String(v).trim());

/** The fields of a verified record still empty and allowed to be estimated. */
export const missingFields = (record) => INFERABLE.filter((f) => isEmpty(record?.[f]));

/** One estimate from the model → a clean value, or null (refused). */
export function cleanEstimate(e) {
  if (!e || !INFERABLE.includes(e.field)) return null;
  const value = String(e.value ?? "").trim();
  const basis = String(e.basis ?? "").trim().slice(0, 300);
  if (!value || value.length > 1500 || HEDGE.test(value) || !basis) return null;
  if (e.field === "targetSpecies") {
    const list = value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    return list.length ? { field: e.field, value: list, basis } : null;
  }
  if (e.field === "userSafety") return { field: e.field, value: value.split(/\n|;\s*/).map((s) => s.trim()).filter(Boolean), basis };
  return { field: e.field, value, basis };
}

/**
 * products: [{ blockId, name, known: { field: value }, missing: [field] }]
 * → { estimates: Map(blockId → [{ field, value, basis }]), refused, run }. Throws the model's error unchanged.
 */
export async function estimateMissing({ companyId, versionId, products }, { generate = defaultGenerate } = {}) {
  const ask = products.filter((p) => p.missing.length);
  if (!ask.length) return { estimates: new Map(), refused: 0, run: null, calls: 0 };
  const payload = { products: ask.map((p) => ({ blockId: p.blockId, name: p.name, known: p.known, missing: p.missing })) };
  const contents = [INSTRUCTIONS, `Products:\n${JSON.stringify(payload)}`];
  const { result, run } = await runLogged(
    { companyId, kind: "CATALOGUE_INFER", promptHash: PROMPT_HASH, inputHash: sha16(stableStringify(payload)), entityType: "catalogue_version", entityId: versionId, reason: `${ask.length} product(s) with fields the catalogue doesn't print` },
    () => generate({ model: MODELS.CATALOGUE_INFER.id, temperature: MODELS.CATALOGUE_INFER.temperature, thinkingBudget: MODELS.CATALOGUE_INFER.thinkingBudget, contents, schema: RESPONSE_SCHEMA, maxOutputTokens: 32768 })
  );
  const estimates = new Map();
  let refused = 0;
  for (const p of result?.products || []) {
    const asked = ask.find((a) => a.blockId === p.blockId);
    if (!asked) continue; // a block it wasn't asked about
    const out = [];
    for (const e of p.estimates || []) {
      const c = e && asked.missing.includes(e.field) ? cleanEstimate(e) : null; // never a field the catalogue printed
      if (c && !out.some((x) => x.field === c.field)) out.push(c);
      else refused++;
    }
    if (out.length) estimates.set(p.blockId, out);
  }
  return { estimates, refused, run, calls: 1 };
}
