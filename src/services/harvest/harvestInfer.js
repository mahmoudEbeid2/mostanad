// Part B of the 28 Nov add-on: every DESCRIPTIVE field still empty after the files are read is
// estimated — never left for the person to type. Each estimate:
//   - goes into the product (so every certificate of it is filled), with provenance
//     { tier: "I", estimated: true, printable: true, basis, reasoning, modelId, promptHash }
//   - is printed on the certificate with a «مستنتج» chip (flag `estimated`), never blocking a draft,
//     an export or an approval, and is never presented as coming from a document
//   - is accepted by a person with one click («اعتمد كل المستنتج»: confirmedAt)
// Never estimated, on any path: lab results, batch / lot numbers, batch size, production / expiry
// dates, registration numbers, quantities, invoice numbers, composition amounts, names and codes.
import { prisma } from "../../lib/prisma.js";
import geminiClient from "../ai/geminiClient.js";
import { MODELS } from "../ai/modelRegistry.js";
import { geminiDisabled } from "../ai/geminiGuard.js";
import { sha16 } from "../certificates/ai/aiRunLog.js";
import { HEDGE } from "../catalogues/extraction/catalogueInference.js";

// product column → what the model is told it is
export const DESCRIPTIVE = {
  appearance: "appearance as a specification would print it (e.g. \"Clear yellow liquid\")",
  physicalForm: "product form (e.g. Liquid, Powder, Injectable solution, Oral solution)",
  productType: "category (e.g. Supplement, Antibiotic, Antiparasitic, Vitamin)",
  storage: "storage conditions",
  validity: "shelf life (e.g. \"24 months from the production date\")",
  dosage: "dosage and administration text",
  routeOfAdmin: "route of administration (e.g. Oral, via drinking water; Intramuscular)",
  indications: "indications",
  targetSpecies: "target species, comma-separated",
  // no compositionBasis: a basis is only what a COC or label prints (QA 27 Nov), never estimated
};
const MAX_PER_CALL = 15;

const INSTRUCTIONS = [
  "You complete the DESCRIPTIVE data of veterinary / animal-feed products for their certificates, from professional knowledge of products of the same kind.",
  "For each product you get what is known about it (composition, form, packs, category…), the fields that are still empty (`missing`), and the company's similar products with their values.",
  "Fill each missing field that a professional can state cleanly for this product. Specifications (`spec:<Test>`) are the specification limit or text a COA prints for that test (e.g. pH \"5.0 - 7.0\", Appearance \"Clear yellow liquid\", Assay \"90 - 110 % of the labeled amount\").",
  "Prefer what a similar product of the same company states (then `basis` names it: \"similar product ADD-E120\"); else the product's kind (\"water-soluble vitamin premixes\").",
  "Each value is final, as it would be printed — never hedged (no likely / probably / approx / unknown, no question marks). If you can't state it cleanly, leave it out.",
  "`reasoning`: one or two short sentences why this value fits this product. `basis`: what it rests on (a similar product's name, or the product type).",
  "NEVER give: analysis results, batch or lot numbers, batch size, production or expiry dates, registration numbers, quantities, invoice numbers, ingredient amounts, names or codes.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productId: { type: "string" },
          estimates: {
            type: "array",
            items: {
              type: "object",
              properties: { field: { type: "string", description: "a key from `missing`" }, value: { type: "string" }, reasoning: { type: "string" }, basis: { type: "string" } },
              required: ["field", "value", "reasoning", "basis"],
            },
          },
        },
        required: ["productId", "estimates"],
      },
    },
  },
  required: ["products"],
};
export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(SCHEMA));

const isEmpty = (v) => v === null || v === undefined || (Array.isArray(v) ? !v.length : !String(v).trim());

/** The tests the company's certificate designs print a specification for (specifications.values.<Test>) */
export async function specTestsOf(companyId) {
  const fields = await prisma.templateField.findMany({ where: { version: { template: { companyId } }, source: { path: ["kind"], equals: "product" } }, select: { source: true } });
  return [...new Set(fields.map((f) => String(f.source?.path || "")).filter((p) => p.startsWith("specifications.values.")).map((p) => p.slice("specifications.values.".length)))].filter(Boolean);
}

/** A product's empty descriptive fields → ["storage", "spec:pH", …] */
export function missingOf(p, tests) {
  const out = Object.keys(DESCRIPTIVE).filter((k) => isEmpty(p[k]) && (k !== "compositionBasis" || (Array.isArray(p.activeIngredients) && p.activeIngredients.length)));
  for (const t of tests) if (isEmpty(p.specifications?.values?.[t])) out.push(`spec:${t}`);
  return out;
}

const known = (p) => ({
  name: p.name,
  category: p.productType || p.category?.name || undefined,
  form: p.physicalForm || undefined,
  packaging: p.packaging || undefined,
  composition: Array.isArray(p.activeIngredients) ? p.activeIngredients.slice(0, 25).map((i) => [i.name, i.concentration || i.amountRaw].filter(Boolean).join(" ")) : undefined,
  basis: p.compositionBasis || undefined,
  indications: p.indications || undefined,
  species: p.targetSpecies?.length ? p.targetSpecies : undefined,
  specifications: p.specifications?.values && Object.keys(p.specifications.values).length ? p.specifications.values : undefined,
});

/** An estimate → a clean value for its column (null: refused) */
export function cleanEstimate(e, missing) {
  const field = String(e?.field || "").trim();
  if (!missing.includes(field)) return null; // never a field that has a value, never a field not asked
  const value = String(e.value ?? "").trim();
  const reasoning = String(e.reasoning ?? "").trim().slice(0, 400);
  const basis = String(e.basis ?? "").trim().slice(0, 200);
  if (!value || value.length > 1500 || HEDGE.test(value) || !basis) return null;
  if (field === "targetSpecies") {
    const list = value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    return list.length ? { field, value: list, reasoning, basis } : null;
  }
  return { field, value, reasoning, basis };
}

/**
 * Estimate the empty descriptive fields of these products (one company) and write them, marked.
 * → { asked, filled, byProduct: { [id]: [field] }, modelId } — never throws for a model failure
 */
export async function inferProductGaps({ companyId, productIds, tests = null }) {
  if (geminiDisabled() || !productIds?.length) return { asked: 0, filled: 0, byProduct: {}, skipped: geminiDisabled() ? "GEMINI_DISABLED" : null };
  const specTests = tests || (await specTestsOf(companyId));
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId }, include: { category: { select: { name: true } } } });
  const ask = products.map((p) => ({ p, missing: missingOf(p, specTests) })).filter((x) => x.missing.length);
  if (!ask.length) return { asked: 0, filled: 0, byProduct: {} };
  // the company's other products with values: what "a similar product" can point to
  const others = await prisma.product.findMany({ where: { companyId, id: { notIn: productIds } }, take: 40, orderBy: { updatedAt: "desc" }, include: { category: { select: { name: true } } } });
  const similar = others.map(known).filter((k) => Object.keys(k).length > 2);
  const modelId = MODELS.PRODUCT_INFER.id;
  let filled = 0;
  const byProduct = {};
  for (let i = 0; i < ask.length; i += MAX_PER_CALL) {
    const chunk = ask.slice(i, i + MAX_PER_CALL);
    const payload = { fields: { ...DESCRIPTIVE, "spec:<Test>": "the specification a COA prints for that test" }, products: chunk.map(({ p, missing }) => ({ productId: p.id, known: known(p), missing })), similarProducts: similar };
    let result;
    try {
      result = await geminiClient.generateJson({
        ledger: { feature: "certificates.inference" },
        model: modelId,
        temperature: MODELS.PRODUCT_INFER.temperature,
        thinkingBudget: MODELS.PRODUCT_INFER.thinkingBudget,
        maxOutputTokens: 32768,
        contents: [INSTRUCTIONS, JSON.stringify(payload)],
        schema: SCHEMA,
      });
    } catch (err) {
      console.error(`[infer] ${chunk.length} product(s) of ${companyId}: ${err.message}`);
      continue; // the fields stay empty (flagged missing) — never a guess written by code
    }
    for (const out of result?.products || []) {
      const hit = chunk.find((x) => x.p.id === out.productId);
      if (!hit) continue;
      const fresh = await prisma.product.findUnique({ where: { id: hit.p.id } });
      const missing = missingOf(fresh, specTests); // what is STILL empty (a person or a file may have filled it meanwhile)
      const data = {};
      const prov = { ...(fresh.fieldProvenance || {}) };
      const specs = { ...(fresh.specifications?.values || {}) };
      const done = [];
      for (const e of out.estimates || []) {
        const c = cleanEstimate(e, missing);
        if (!c || done.includes(c.field)) continue;
        const mark = { tier: "I", estimated: true, printable: true, source: "inference", basis: c.basis, reasoning: c.reasoning, modelId, promptHash: PROMPT_HASH, at: new Date().toISOString() };
        if (c.field.startsWith("spec:")) {
          const test = c.field.slice(5);
          specs[test] = c.value;
          prov[`specifications.values.${test}`] = mark;
        } else {
          data[c.field] = c.value;
          prov[c.field] = mark;
        }
        done.push(c.field);
      }
      if (!done.length) continue;
      if (done.some((f) => f.startsWith("spec:"))) data.specifications = { type: fresh.specifications?.type || "string", ...(fresh.specifications || {}), values: specs };
      await prisma.product.update({ where: { id: fresh.id }, data: { ...data, fieldProvenance: prov } });
      byProduct[fresh.id] = done;
      filled += done.length;
    }
  }
  return { asked: ask.reduce((n, x) => n + x.missing.length, 0), filled, byProduct, modelId };
}

/**
 * «اعتمد كل المستنتج»: a person accepts every printed estimate of these products (confirmedAt / by).
 * → { products, accepted }
 */
export async function acceptEstimates({ companyId, productIds, userId = null }) {
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId }, select: { id: true, fieldProvenance: true } });
  let accepted = 0;
  const at = new Date().toISOString();
  for (const p of products) {
    const prov = { ...(p.fieldProvenance || {}) };
    let n = 0;
    for (const [path, v] of Object.entries(prov)) {
      if (v?.estimated === true && v.printable === true && !v.confirmedAt) {
        prov[path] = { ...v, confirmedAt: at, confirmedByUserId: userId, acceptedInBulk: true };
        n++;
      }
    }
    if (n) await prisma.product.update({ where: { id: p.id }, data: { fieldProvenance: prov } });
    accepted += n;
  }
  return { products: products.length, accepted };
}
