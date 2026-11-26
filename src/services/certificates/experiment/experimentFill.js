// PART 3: in experiment mode the AI fills EVERY field still empty — lab results, batch numbers, dates and
// registration numbers included — so the owner sees a fully filled certificate. Each value is marked
// «مستنتج (تجربة)» (estimated, experiment) and the certificate is a watermarked, locked sample.
// One call per certificate; a failure leaves the fields empty (the sample is still made and still locked).
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

const INSTRUCTIONS = [
  "This is a TEST: fill a veterinary / animal-feed product certificate completely, so its layout and wording can be judged.",
  "For every field listed, give a realistic, well-formed value for this product: specification limits, lab results consistent with them, a batch number in the company's style, production and expiry dates (expiry after production, by the product's validity), batch size, registration number, quantities.",
  "Values only — no explanations, no placeholders like XXX. Dates as DD/MM/YYYY unless the field's sample shows another shape.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: { values: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } } },
  required: ["values"],
};

/**
 * fields: [{ key, label, sampleShape }] still empty; ctx: the resolver context (product, item, company)
 * → { [key]: value } (only keys asked for)
 */
export async function experimentFill(fields, ctx) {
  if (!fields.length) return {};
  const p = ctx.product || {};
  const product = { name: p.name, category: p.productType || p.category?.name, form: p.physicalForm, packaging: p.packaging, validity: p.validity, composition: Array.isArray(p.activeIngredients) ? p.activeIngredients.slice(0, 30).map((i) => [i.name, i.concentration || i.amountRaw].filter(Boolean).join(" ")) : undefined, specifications: p.specifications?.values };
  // a sample's SHAPE (letters → A, digits → 9), never its text: the format is kept, nothing of the sample is copied
  const shape = (s) => String(s || "").replace(/[A-Za-z]/g, "A").replace(/\d/g, "9").slice(0, 40);
  const ask = fields.map((f) => ({ key: f.key, label: f.label, shape: shape(f.sampleValue) || undefined }));
  const out = await geminiClient.generateJson({
    ledger: { feature: "certificates.inference" },
    model: MODELS.PRODUCT_INFER.id,
    temperature: 0.2,
    thinkingBudget: 1024,
    maxOutputTokens: 8192,
    contents: [INSTRUCTIONS, JSON.stringify({ company: ctx.company?.name, product, line: ctx.item || {}, fields: ask })],
    schema: SCHEMA,
  });
  const wanted = new Set(fields.map((f) => f.key));
  return Object.fromEntries((out?.values || []).filter((v) => wanted.has(v.key) && String(v.value || "").trim()).map((v) => [v.key, String(v.value).trim().slice(0, 300)]));
}
