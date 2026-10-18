// Proves composer.js is actually WIRED into contextBuilder.js/labelGenerator.js
// (task 4) — not just built-and-tested-standalone. Pure/no live Gemini calls:
// buildContext, buildRegulatoryBlock, buildSchemaBlock, and toGeminiSchema are
// all synchronous/DB-free, so this exercises the real integration code path
// with a hand-built composedFields list instead of round-tripping through the
// database + a real ingestion.
import { z } from "zod";
import { buildContext, buildRegulatoryBlock, buildSchemaBlock } from "../src/services/label/generation/contextBuilder.js";
import { geminiResponseSchema } from "../src/services/label/schema/geminiSchema.js";
import { labelSchema } from "../src/services/label/schema/labelSchema.js";
import { toGeminiSchema, toZodSchema, rejectUnknownKeys } from "../src/services/label/schema/composer.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

function run() {
  log("\n=== Generation-path composer wiring (task 4) ===\n", "bold");

  const fakeProfile = { productType: "compound_feed", activeIngredients: [], targetSpecies: ["Poultry"], country: "Fictionland-Wiring", language: "en", confirmedFacts: {} };

  // ── No composedFields — must degrade EXACTLY to today's static behavior ──
  log("-- No composedFields: backward-compatible with pre-composer behavior --", "cyan");
  const staticCtx = buildContext({ rules: [], rankedReferences: [], profile: fakeProfile });
  assert("With no composedFields, the schema block uses the static geminiResponseSchema", JSON.stringify(staticCtx.schema) === JSON.stringify(geminiResponseSchema));
  assert("The regulatory block still opens with REGULATORY_RULES", staticCtx.prompt.includes("<REGULATORY_RULES>"));
  assert("No CATALOG_FIELD_REQUIREMENTS section when there's nothing to contribute", !staticCtx.prompt.includes("<CATALOG_FIELD_REQUIREMENTS>"));

  // ── With composedFields: catalog-only field, core field refined by a doc ──
  log("\n-- With composedFields: composed schema replaces the static one --", "cyan");
  const composedFields = [
    ...Object.keys(labelSchema.shape).map((key) => ({
      key, isCore: true, requirement: "required", appliesWhen: [], requiredLanguages: [], formatSpec: [],
      zodType: labelSchema.shape[key], contributedBy: [],
    })),
    {
      key: "withdrawal_declaration_code", isCore: false, requirement: "required",
      appliesWhen: [], requiredLanguages: ["ar", "en"], formatSpec: [{ value: "must be a 6-digit code", documentId: "doc-1" }],
      zodType: z.string(), contributedBy: [{ documentId: "doc-1", section: "4.2", quote: "must state a 6-digit withdrawal declaration code", confidence: 0.9 }],
    },
  ];

  const composedSchema = toGeminiSchema(composedFields);
  assert("Composed schema differs from the static one once a catalog field is added", JSON.stringify(composedSchema) !== JSON.stringify(geminiResponseSchema));
  assert("Composed schema's properties include the new catalog-only field", "withdrawal_declaration_code" in (composedSchema.properties || {}));
  assert("Composed schema still includes every core field", Object.keys(labelSchema.shape).every((k) => k in (composedSchema.properties || {})));

  const composedCtx = buildContext({ rules: [], rankedReferences: [], profile: fakeProfile, composedFields });
  assert("buildContext uses the COMPOSED schema when composedFields is supplied", JSON.stringify(composedCtx.schema) === JSON.stringify(composedSchema));
  assert("The catalog field's requirement/languages/format appear in the regulatory block, not just the schema", composedCtx.prompt.includes("withdrawal_declaration_code") && composedCtx.prompt.includes("ar,en"));
  assert("No 'example' value ever appears in the prompt (composer only reads catalogs via the stripped reader)", !composedCtx.prompt.includes("6-digit code needs an example"));

  // ── Prompt order preserved: regulatory -> schema -> references -> product ──
  log("\n-- Block ordering preserved: [regulatory] -> [schema] -> [references] -> [product data] --", "cyan");
  const order = ["<REGULATORY_RULES>", "<CATALOG_FIELD_REQUIREMENTS>", "<OUTPUT_SCHEMA>", "<REFERENCE_LABELS>", "<PRODUCT_DATA>"];
  const positions = order.map((tag) => composedCtx.prompt.indexOf(tag));
  assert("Every expected block is present", positions.every((p) => p !== -1));
  assert("Blocks appear in the required cache-friendly order", positions.every((p, i) => i === 0 || p > positions[i - 1]));

  // ── Closed-schema enforcement (rejectUnknownKeys) ────────────────────────
  log("\n-- Closed schema: a key outside the composed list is rejected, not kept --", "cyan");
  const modelOutput = { productName: { translations: { en: "x" }, primary: "en" }, some_hallucinated_field: "should not survive" };
  const { cleaned, rejectedKeys } = rejectUnknownKeys(modelOutput, composedFields);
  assert("A known key survives", "productName" in cleaned);
  assert("An unknown key is stripped from the cleaned output", !("some_hallucinated_field" in cleaned));
  assert("The rejected key is reported, not silently dropped", rejectedKeys.includes("some_hallucinated_field"));

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run();
