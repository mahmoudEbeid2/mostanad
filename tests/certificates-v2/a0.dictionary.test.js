// Certificate AI layers A0 — the company data dictionary builder (plan.md
// §3.2), AI settings defaults/status rules (§3.3, P4, §12 Q1), input hashing
// (aiRunLog) and the stored invoice text (§6.1). Pure functions: no API, no
// database.
import { makeAssert, finish } from "./helpers.js";
import { observeProducts, schemaEntries } from "../../src/services/certificates/dictionary/dataDictionary.js";
import { withDefaults, initialStatus, aiAllowed, AI_SETTINGS_DEFAULTS } from "../../src/services/certificates/ai/aiSettings.js";
import { stableStringify, hashInput } from "../../src/services/certificates/ai/aiRunLog.js";
import { clampConfidence } from "../../src/services/certificates/ai/aiSuggestions.js";
import { shapeExtraction, cleanText, MAX_TEXT_CHARS } from "../../src/services/certificates/invoices/invoiceExtractor.js";
import { parse } from "../../src/services/certificates/paths/sourcePath.js";
import { validateSource } from "../../src/services/certificates/templates/sourceCatalogue.js";

const { assert, counts } = makeAssert();
const COLS = ["activeIngredients", "specifications"];

const products = [
  { name: "A", producer: "ADDVET", specifications: { type: "string", values: { pH: "3.0-5.0", "Assay %": "98", ws_period: "28 days" } }, activeIngredients: [{ name: "Vitamin E", concentration: "120000 mg" }, { name: "Sodium selenite", concentration: "60 mg" }] },
  { name: "B", producer: "ADDVET", specifications: { type: "string", values: { PH: "6.5-7.5" } }, activeIngredients: [{ name: "vitamin e", concentration: "50 g" }] },
  { name: "C", specifications: { values: { pH: "2.0 – 3.0", note: "x".repeat(200) } }, activeIngredients: null },
  { name: "D", specifications: null, activeIngredients: [] },
];
const entries = observeProducts(products, COLS);
const at = (p) => entries.find((e) => e.path === p);

console.log("\n🧪 Observed JSON shapes");
const ph = at("product.specifications.values.pH");
assert("pH / PH grouped into one entry", ph && entries.filter((e) => /values\.(pH|PH)$/i.test(e.path)).length === 1, entries.map((e) => e.path));
assert("… every spelling kept in labels", ph?.labels?.length === 2 && ph.labels.includes("pH") && ph.labels.includes("PH"), ph?.labels);
assert("… coverage = 3 of 4 products", ph?.coverage === 0.75, ph?.coverage);
assert("… distinct values and examples", ph?.distinct === 3 && ph.examples.length === 3 && ph.examples.includes("2.0 – 3.0"));
assert("… label Product › Specifications › pH", ph?.label === "Product › Specifications › pH", ph?.label);
const assay = at('product.specifications.values["Assay %"]');
assert("a key that isn't an identifier is quoted", !!assay && assay.coverage === 0.25, entries.map((e) => e.path));
const note = at("product.specifications.values.note");
assert("examples are truncated to 60 characters", note?.examples[0].length === 60 && note.examples[0].endsWith("…"));
const coll = at("product.activeIngredients[]");
assert("array of objects → a collection entry", coll?.type === "collection" && coll.pickable === false);
assert("… with its identifying key and values", coll?.keyField === "name" && coll.keyValues[0] === "Vitamin E", coll);
assert("… coverage = products that have the list (2 of 4; [] counts as none)", coll?.coverage === 0.5, coll?.coverage);
assert("collection children are described, not pickable", at("product.activeIngredients[].concentration")?.pickable === false);
const vitE = at('product.activeIngredients[name="Vitamin E"].concentration');
assert('[name="Vitamin E"].concentration is listed and pickable', vitE?.pickable === true && vitE.coverage === 0.5 && vitE.examples.includes("120000 mg") && vitE.examples.includes("50 g"), vitE);
assert("… its label", vitE?.label === "Product › Active ingredients › [Vitamin E] › Concentration", vitE?.label);
assert('[name="Sodium selenite"].concentration (1 product)', at('product.activeIngredients[name="Sodium selenite"].concentration')?.coverage === 0.25);
assert("every pickable path parses and validates as a field source", entries.filter((e) => e.pickable).every((e) => parse(e.path).ok && validateSource({ kind: "product", path: e.path.slice(8) }).length === 0), entries.filter((e) => e.pickable && !parse(e.path).ok));
assert("sorted by coverage", entries.every((e, i) => i === 0 || entries[i - 1].coverage >= e.coverage));
assert("no products → no entries, no crash", observeProducts([], COLS).length === 0);
assert("hostile keys are not walked into", observeProducts([{ specifications: JSON.parse('{"__proto__":{"x":"1"},"ok":"y"}') }], COLS).every((e) => !e.path.includes("__proto__")));
const deep = { specifications: {} };
let cur = deep.specifications;
for (let i = 0; i < 20; i++) cur = cur[`k${i}`] = {};
cur.leaf = "x";
assert("depth is bounded", observeProducts([deep], COLS).every((e) => e.path.split(".").length < 12));

console.log("\n🧪 Schema entries");
const schema = schemaEntries(products);
const producer = schema.find((e) => e.path === "product.producer");
assert("product columns with coverage + examples", producer?.coverage === 0.5 && producer.examples[0] === "ADDVET", producer);
assert("relations, invoice line/header, company, brand are listed", ["product.category.name", "product.brand.name", "item.batchNo", "invoice.invoiceNumber", "company.name", "brand.name"].every((p) => schema.some((e) => e.path === p)));
assert("positional ingredient slots are not (superseded by [name=…])", !schema.some((e) => /activeIngredients\[\d+\]/.test(e.path)));

console.log("\n🧪 AI settings (plan.md §3.3, P4, §12 Q1)");
assert("defaults: all on, threshold 0.90, auto-accept OFF (Q1: confirm everything first)", stableStringify(withDefaults(null)) === stableStringify(AI_SETTINGS_DEFAULTS) && AI_SETTINGS_DEFAULTS.autoAccept === false && AI_SETTINGS_DEFAULTS.autoAcceptThreshold === 0.9);
assert("stored values override, junk is ignored", withDefaults({ enabled: false, autoAcceptThreshold: 3, allowAiMatching: "no", extra: 1 }).enabled === false && withDefaults({ autoAcceptThreshold: 3 }).autoAcceptThreshold === 0.9 && withDefaults({ allowAiMatching: "no" }).allowAiMatching === true && !("extra" in withDefaults({ extra: 1 })));
const on = withDefaults({ autoAccept: true });
assert("auto-accept off → every suggestion pending", initialStatus(withDefaults(null), { confidence: 0.99 }) === "pending");
assert("auto-accept on, ≥ threshold → auto_accepted", initialStatus(on, { confidence: 0.9 }) === "auto_accepted");
assert("below threshold → pending", initialStatus(on, { confidence: 0.89 }) === "pending");
assert("unverified evidence → pending however confident (P2)", initialStatus(on, { confidence: 1, evidenceVerified: false }) === "pending");
assert("master switch off → no layer runs", aiAllowed(withDefaults({ enabled: false }), "allowAiMatching") === false && aiAllowed(on, "allowAiMatching") === true && aiAllowed(withDefaults({ allowAiMatching: false }), "allowAiMatching") === false);
assert("confidence clamped to [0,1]", clampConfidence(1.7) === 1 && clampConfidence(-2) === 0 && clampConfidence("x") === 0 && clampConfidence(0.4) === 0.4);

console.log("\n🧪 aiRunLog hashing");
assert("key order does not change the hash", hashInput({ a: 1, b: [1, { c: 2, d: 3 }] }) === hashInput({ b: [1, { d: 3, c: 2 }], a: 1 }));
assert("a different input changes it", hashInput({ a: 1 }) !== hashInput({ a: 2 }) && hashInput({ a: 1 }).length === 16);

console.log("\n🧪 Stored invoice text (plan.md §6.1)");
const shaped = shapeExtraction({ textContent: "=== Page 1 ===\r\nINVOICE 77   \r\nBatch: HSPhar02509001\n=== Page 2 ===\nTotal", header: {}, items: [] });
assert("textContent kept with page markers, line endings normalised", shaped.textContent === "=== Page 1 ===\nINVOICE 77\nBatch: HSPhar02509001\n=== Page 2 ===\nTotal", shaped.textContent);
assert("a missing page marker is added", cleanText("just text") === "=== Page 1 ===\njust text");
assert("no text → null (never invented)", shapeExtraction({ header: {}, items: [] }).textContent === null && cleanText("   ") === null);
assert("bounded", cleanText("x".repeat(MAX_TEXT_CHARS + 50)).length === MAX_TEXT_CHARS);

await finish(counts);
