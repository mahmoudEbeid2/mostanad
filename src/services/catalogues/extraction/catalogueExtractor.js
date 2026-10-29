import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { runLogged, sha16, stableStringify } from "../../certificates/ai/aiRunLog.js";

// Structuring (plan.md §15.3 step 3): catalogue blocks → schema-bound product
// records, CATALOGUE_EXTRACT through geminiClient. The model COPIES: every value
// comes with a quote of its own block, which code verifies (recordVerifier.js);
// nothing it says is trusted until then. Several blocks go in one call, each
// under its own id — a value can only be accepted against the block it names,
// so grouping can't carry text from one product to another.

export const BLOCKS_PER_CALL = Math.max(1, Number(process.env.CATALOGUE_BLOCKS_PER_CALL) || 6);

const INSTRUCTIONS = [
  "You read blocks of text cut from a manufacturer's product catalogue (feed additives / veterinary products). Each block is one product's page area. Cells of one printed line are separated by a TAB.",
  "For every block return its record. COPY values exactly as printed — never translate, convert, complete, correct or guess. A value that is not printed in THAT block is null.",
  "Every value needs `quote`: an exact passage copied from the SAME block that contains the value (a few words around it, or the whole line). Never quote another block.",
  "Fields: name (the product name as printed), productCode (the printed CODE), physicalForm (FORM), subtitle (the line under the name), categoryProposal (a short product category the page states or shows, e.g. its section tab or subtitle — null if none), indications (BENEFITS / INDICATIONS / FUNCTIONS text), description (a descriptive paragraph, if any), dosage (DOSAGE / HOW TO USE text), mixingInstructions, withdrawalPeriod (WITHDRAWAL TIMES text as printed, e.g. \"- None.\"), storage (the STORAGE text; when there is none, the storage sentences under PRECAUTIONS, e.g. \"Store in a cool and dry place.\"), packaging (PACKING text), contraindications, appearance, registrationNumber, targetSpecies (species the block names, with one quote containing them), userSafety (each PRECAUTIONS line).",
  "compositionBasis: the composition's basis line as printed (\"Each 1 Litre contains:\", \"Contains per mL:\").",
  "activeIngredients: one entry per COMPOSITION row: name and amountRaw exactly as printed (\"200.000 mg\", \"100 000 000 I.U.\" — keep every dot, comma and space). `quote` = that ONE printed line holding the name and its amount. When no amount is printed for an ingredient, amountRaw is null — never put words like \"Extract\", \"Added\" or \"Not specified\" in amountRaw. Composition goes ONLY here (never into specifications).",
  "Return exactly ONE record for EVERY block you are given — none skipped, none merged — with its blockId copied exactly.",
  "isProduct: false when the block is not a product (a cover, an index, an about-us page).",
  "Context blocks (cover / back pages) are given once: from them return catalogue.producer and catalogue.origin (country) with a quote and the context block's id — null when not printed.",
].join("\n");

const VQ = { type: "object", nullable: true, properties: { value: { type: "string", nullable: true }, quote: { type: "string", nullable: true } } };
const VQB = { type: "object", nullable: true, properties: { value: { type: "string", nullable: true }, quote: { type: "string", nullable: true }, blockId: { type: "string", nullable: true } } };
const SCALARS = ["name", "productCode", "physicalForm", "subtitle", "indications", "description", "dosage", "mixingInstructions", "withdrawalPeriod", "storage", "packaging", "contraindications", "appearance", "registrationNumber", "compositionBasis"];

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          blockId: { type: "string" },
          isProduct: { type: "boolean" },
          ...Object.fromEntries(SCALARS.map((k) => [k, VQ])),
          categoryProposal: { type: "string", nullable: true },
          targetSpecies: { type: "object", nullable: true, properties: { values: { type: "array", items: { type: "string" } }, quote: { type: "string", nullable: true } } },
          userSafety: { type: "array", items: VQ },
          activeIngredients: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, amountRaw: { type: "string", nullable: true }, quote: { type: "string" } }, required: ["name", "quote"] },
          },
        },
        required: ["blockId", "isProduct"],
      },
    },
    catalogue: { type: "object", nullable: true, properties: { producer: VQB, origin: VQB } },
  },
  required: ["products"],
};

export const SCALAR_FIELDS = SCALARS;
export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
const defaultGenerate = (args) => geminiClient.generateJson({ ...args, ledger: { feature: "catalogue.extract" } });

/** runLogged opts that put the catalogue and its pages on every ledger row of the call */
export const ledgerTags = (meta) => (meta?.catalogueId ? { parentType: "catalogue", parentId: meta.catalogueId, meta } : {});

/**
 * One call for a group of product blocks (+ the context blocks on the first call).
 * blocks: [{ id, page, text }] · context: [{ id, page, text }] | null
 * → { result: { products, catalogue }, run, inputHash }. Throws the model's error unchanged.
 */
/** meta: { catalogueId, pages } — the catalogue and ORIGINAL page numbers this call reads, on its ledger rows */
export async function extractGroup({ companyId, versionId, blocks, context = null, meta = null }, { generate = defaultGenerate } = {}) {
  const payload = {
    blocks: blocks.map((b) => ({ blockId: b.id, page: b.page, text: b.text })),
    ...(context?.length ? { contextBlocks: context.map((b) => ({ blockId: b.id, page: b.page, text: b.text })) } : {}),
  };
  // instructions first (shared, cacheable), then the blocks
  const contents = [INSTRUCTIONS, `Blocks:\n${JSON.stringify(payload)}`];
  const inputHash = sha16(stableStringify(payload));
  const { result, run } = await runLogged(
    { companyId, kind: "CATALOGUE_EXTRACT", promptHash: PROMPT_HASH, inputHash, entityType: "catalogue_version", entityId: versionId, ...ledgerTags(meta), reason: `${blocks.length} catalogue block(s)${meta?.pages?.length ? ` from page${meta.pages.length > 1 ? "s" : ""} ${meta.pages.join(", ")}` : ""}` },
    () =>
      generate({
        model: MODELS.CATALOGUE_EXTRACT.id,
        temperature: MODELS.CATALOGUE_EXTRACT.temperature,
        thinkingBudget: MODELS.CATALOGUE_EXTRACT.thinkingBudget,
        contents,
        schema: RESPONSE_SCHEMA,
        maxOutputTokens: 32768,
      })
  );
  return { result: result || { products: [] }, run, inputHash };
}
