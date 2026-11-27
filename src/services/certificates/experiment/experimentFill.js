// PART 3: in experiment mode the AI fills every REQUIRED field still empty — lab results, batch numbers, dates and
// registration numbers included — so the owner sees a fully filled certificate. Each value is marked
// «مستنتج (تجربة)» (estimated, experiment) and the certificate is a watermarked, locked sample.
// One call per certificate; a failure leaves the fields empty (the sample is still made and still locked).
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

const INSTRUCTIONS = [
  "This is a TEST: fill a veterinary / animal-feed product certificate completely, so its layout and wording can be judged.",
  "For every field listed, give a realistic, well-formed value for this product: specification limits, lab results consistent with them, a batch number in the company's style, production and expiry dates (expiry after production, by the product's validity), batch size, registration number, quantities.",
  'Values only — no explanations, no placeholders like XXX, never "N/A". Dates as DD/MM/YYYY unless the field\'s shape shows another one.',
  'Every value is complete: never cut a word to fit ("Non-pyrogenic", never "Non-pyro"). Where a place is short, choose a shorter complete wording ("Complies"); the layout shrinks text that is still too long.',
  'Batch size: the line\'s `batch` facts say what the order is. A batch size is a quantity of product in a real unit — consistent with pack × quantity (2400 × 100 mL → 240 L), or the quantity in its own unit ("2400 units"). Never a count with a volume or mass unit ("2400 L" for 2400 bottles).',
].join("\n");

const SCHEMA = {
  type: "object",
  properties: { values: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } } },
  required: ["values"],
};

// the line's batch facts (QA 28 Nov: ADDOXY's batch size printed "2400 L" for 2400 × 100 mL): the quantity
// with its own unit, and pack × quantity when the pack is a volume or a mass
const UNIT = { ml: ["L", 1e-3], cc: ["L", 1e-3], l: ["L", 1], g: ["kg", 1e-3], gm: ["kg", 1e-3], gr: ["kg", 1e-3], kg: ["kg", 1] };
const num = (n) => String(Number(n.toPrecision(6)));
export function batchFacts(item = {}, product = {}) {
  const qty = Number(String(item?.quantity ?? "").replace(/[, ]/g, ""));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const pack = String(item.packing || item.pack || product?.packaging || "");
  const unit = item.unit && !/^(l|ml|kg|g)$/i.test(item.unit) ? item.unit : "units";
  const facts = { quantity: `${num(qty)} ${unit}`, ...(pack ? { pack } : {}) };
  const m = /(\d+(?:[.,]\d+)?)\s*(ml|cc|l|kg|gm|gr|g)\b/i.exec(pack);
  if (m) {
    const [u, k] = UNIT[m[2].toLowerCase()];
    facts.total = `${num(qty * Number(m[1].replace(",", ".")) * k)} ${u}`;
  }
  return facts;
}
export const isBatchSize = (f) => /\b(batch|lot)\s*size\b|حجم\s*(التشغيلة|الدفعة)/i.test(String(f?.label || ""));

/** A batch size given as the bare count with a volume / mass unit → pack × quantity, or the count in units */
export function guardBatchSize(value, facts) {
  if (!facts) return value;
  const count = facts.quantity.split(" ")[0];
  const m = /^\s*([\d.,]+)\s*(l|liters?|litres?|ml|kg|g)\s*$/i.exec(String(value || ""));
  return m && m[1].replace(/,/g, "") === count ? facts.total || facts.quantity : value;
}

/**
 * fields: [{ key, label, sampleValue }] still empty; ctx: the resolver context (product, item, company)
 * → { [key]: value } (only keys asked for)
 */
export async function experimentFill(fields, ctx) {
  if (!fields.length) return {};
  const p = ctx.product || {};
  const product = { name: p.name, category: p.productType || p.category?.name, form: p.physicalForm, packaging: p.packaging, validity: p.validity, composition: Array.isArray(p.activeIngredients) ? p.activeIngredients.slice(0, 30).map((i) => [i.name, i.concentration || i.amountRaw].filter(Boolean).join(" ")) : undefined, specifications: p.specifications?.values };
  // a sample's SHAPE (letters → A, digits → 9), never its text: the format is kept, nothing of the sample is
  // copied. Only for a value with digits (a date, a number): a word's shape made the model cut words to its
  // length (QA 28 Nov: "Non-pyro", "Nonpyrog") — a text place says only about how long it is
  const sample = (f) => String(f.sampleValue || "").trim();
  const ask = fields.map((f) => {
    const s = sample(f);
    return { key: f.key, label: f.label, ...(/\d/.test(s) ? { shape: s.replace(/[A-Za-z]/g, "A").replace(/\d/g, "9").slice(0, 40) } : s ? { room: `about ${s.length} characters` } : {}) };
  });
  const batch = batchFacts(ctx.item, p);
  const out = await geminiClient.generateJson({
    ledger: { feature: "certificates.inference" },
    model: MODELS.PRODUCT_INFER.id,
    temperature: 0.2,
    thinkingBudget: 1024,
    maxOutputTokens: 8192,
    contents: [INSTRUCTIONS, JSON.stringify({ company: ctx.company?.name, product, line: { ...(ctx.item || {}), ...(batch ? { batch } : {}) }, fields: ask })],
    schema: SCHEMA,
  });
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return Object.fromEntries(
    (out?.values || [])
      .filter((v) => byKey.has(v.key) && String(v.value || "").trim() && !/^n\/?a$/i.test(String(v.value).trim()))
      .map((v) => {
        const value = String(v.value).trim().slice(0, 300);
        return [v.key, isBatchSize(byKey.get(v.key)) ? guardBatchSize(value, batch) : value];
      })
  );
}
