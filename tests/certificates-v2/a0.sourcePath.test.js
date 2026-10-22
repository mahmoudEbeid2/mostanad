// Certificate AI layers A0 — the source path language (plan.md §3.1, §10).
// Parser + resolver + labels: malformed input, deep arrays, missing keys,
// unicode keys, filters (case/space-insensitive), key variants, the legacy
// adapter, and the guarantee that nothing is ever evaluated.
// Pure functions: no API, no database.
import { makeAssert, finish } from "./helpers.js";
import { parse, parseRelative, resolve, resolveRelative, toLabel, fromSource, canonicalRelative, format } from "../../src/services/certificates/paths/sourcePath.js";
import { resolveField } from "../../src/services/certificates/generation/valueResolver.js";
import { validateSource, TEMPLATE_TOKEN_RE } from "../../src/services/certificates/templates/sourceCatalogue.js";

const { assert, counts } = makeAssert();

const product = {
  name: "ADD-E120",
  specifications: { type: "string", values: { pH: "3.0-5.0", "Assay %": "98.5", "PH value": "x", Größe: "12 cm", "Dichte (g/ml)": "1.02" } },
  activeIngredients: [
    { name: "Vitamin E", concentration: "120000 mg" },
    { name: "Sodium  Selenite", concentration: "60 mg" },
    { Name: "Zinc", concentration: "5 mg", sub: [{ k: "a", v: [1, 2, 3] }] },
  ],
  category: { name: "Supplement" },
};
const ctx = { product, item: { batchNo: "B-1", extra: { Lot: "L-9", "Analysis No": "A-77" } }, invoice: { invoiceNumber: "INV-1" }, company: { name: "Co" } };

console.log("\n🧪 Parse");
assert("product.name", parse("product.name").ok);
assert('quoted key values["pH"]', parse('product.specifications.values["pH"]').ok);
assert("index", parse("product.activeIngredients[0].name").ok);
assert("filter [name=\"…\"]", parse('product.activeIngredients[name="Vitamin E"].concentration').ok);
assert("escaped quote inside a quoted key", parseRelative('a["say \\"hi\\""]').ok && parseRelative('a["say \\"hi\\""]').segments[1].k === 'say "hi"');
assert("unicode identifier", parseRelative("specifications.values.Größe").ok);
for (const [label, bad] of [
  ["unknown root", "products.name"],
  ["root only", "product"],
  ["trailing dot", "product.name."],
  ["double dot", "product..name"],
  ["unterminated quote", 'product.a["pH]'],
  ["empty quoted key", 'product.a[""]'],
  ["missing ]", "product.a[0"],
  ["filter without quotes", "product.a[name=Vitamin]"],
  ["negative index", "product.a[-1]"],
  ["expression", "product.a+1"],
  ["call", "product.name()"],
  ["__proto__", "product.__proto__.x"],
  ["constructor", "product.a.constructor"],
  ["prototype in a quoted key", 'product.a["prototype"]'],
  ["empty", ""],
  ["not a string", null],
  ["too deep", `product.${Array(20).fill("a").join(".")}`],
]) {
  assert(`rejects ${label}`, parse(bad).ok === false, parse(bad));
}

console.log("\n🧪 Resolve");
let r = resolve(ctx, 'product.specifications.values["pH"]');
assert('values["pH"] → 3.0-5.0', r.found && r.value === "3.0-5.0" && r.type === "string", r);
assert("dotted pH works too", resolve(ctx, "product.specifications.values.pH").value === "3.0-5.0");
assert('values["Assay %"]', resolve(ctx, 'product.specifications.values["Assay %"]').value === "98.5");
assert("unicode key", resolve(ctx, "product.specifications.values.Größe").value === "12 cm");
r = resolve(ctx, 'product.activeIngredients[name="Vitamin E"].concentration');
assert("filter → value", r.value === "120000 mg", r);
assert("… records the concrete path it hit", r.path === "product.activeIngredients[0].concentration", r.path);
assert("filter is case- and space-insensitive", resolve(ctx, 'product.activeIngredients[name="sodium selenite"].concentration').value === "60 mg");
assert("filter key spelling variant (Name)", resolve(ctx, 'product.activeIngredients[name="ZINC"].concentration').value === "5 mg");
assert("index", resolve(ctx, "product.activeIngredients[1].concentration").value === "60 mg");
assert("deep arrays", resolve(ctx, "product.activeIngredients[2].sub[0].v[2]").value === 3);
assert("key variant: PH matches pH when unique", resolveRelative({ values: { PH: "7" } }, 'values["pH"]').value === "7");
r = resolveRelative({ values: { PH: "7", ph: "8" } }, 'values["pH"]');
assert("ambiguous key variants → not found (never a guess)", r.found === false, r);
assert("missing key → not found, no throw", resolve(ctx, "product.nope.deeper").found === false);
assert("missing filter value → not found", resolve(ctx, 'product.activeIngredients[name="Iron"].concentration').found === false);
assert("index out of range → not found", resolve(ctx, "product.activeIngredients[9].name").found === false);
assert("index on an object → not found", resolve(ctx, "product.specifications[0]").found === false);
assert("filter on an object → not found", resolve(ctx, 'product.specifications[name="x"]').found === false);
assert("empty string value → not found", resolveRelative({ a: "  " }, "a").found === false);
assert("object value → found, type object", resolve(ctx, "product.specifications.values").type === "object");
assert("item.extra quoted key", resolve(ctx, 'item.extra["Analysis No"]').value === "A-77");
assert("brand falls back to product.brand", resolve({ product: { brand: { name: "B" } } }, "brand.name").value === "B");
assert("no context → not found", resolve(undefined, "product.name").found === false);
assert("malformed path → not found with an error, never throws", resolve(ctx, "product.a[").error && resolve(ctx, "product.a[").found === false);
assert("own properties only (no prototype walk)", resolve({ product: Object.create({ inherited: "x" }) }, "product.inherited").found === false);
assert("functions are never returned", resolveRelative({ f: () => 1 }, "f").found === false);

console.log("\n🧪 Legacy adapter (V2 stored sources, read-time)");
assert("activeIngredients[1].name unchanged", fromSource({ kind: "product", path: "activeIngredients[1].name" }) === "product.activeIngredients[1].name");
assert("specifications.values.Assay % → quoted", canonicalRelative("specifications.values.Assay %") === 'specifications.values["Assay %"]');
assert("… and resolves", resolveRelative(product, "specifications.values.Dichte (g/ml)").value === "1.02");
assert("fromSource of a pathless kind → null", fromSource({ kind: "today" }) === null && fromSource({ kind: "static", text: "x" }) === null);
assert("format round-trips", format(parseRelative('a.b["c d"][2][name="x y"].e').segments) === 'a.b["c d"][2][name="x y"].e');

console.log("\n🧪 Labels");
assert("Specifications › pH", toLabel('product.specifications.values["pH"]') === "Product › Specifications › pH", toLabel('product.specifications.values["pH"]'));
assert("Active ingredients › [Vitamin E] › Concentration", toLabel('product.activeIngredients[name="Vitamin E"].concentration') === "Product › Active ingredients › [Vitamin E] › Concentration");
assert("index → #n", toLabel("product.activeIngredients[0].name") === "Product › Active ingredients › #1 › Name");
assert("invoice line root", toLabel("item.batchNo").startsWith("Invoice line › "));

console.log("\n🧪 Through the value resolver and validation (fields, combinations)");
const v = (source) => resolveField({ key: "k", source }, ctx).value;
assert("field source with a quoted key", v({ kind: "product", path: 'specifications.values["Assay %"]' }) === "98.5");
assert("field source with a filter", v({ kind: "product", path: 'activeIngredients[name="Vitamin E"].concentration' }) === "120000 mg");
assert("legacy positional source still resolves", v({ kind: "product", path: "activeIngredients[1].name" }) === "Sodium  Selenite");
assert("combination with grammar placeholders", v({ kind: "template", template: 'pH {{product.specifications.values["pH"]}} / {{item.extra["Lot"]}}' }) === "pH 3.0-5.0 / L-9");
assert("combination with a missing placeholder → empty (D7)", v({ kind: "template", template: '{{product.activeIngredients[name="Iron"].concentration}} mg' }) === "");
globalThis.__pwned = false;
assert("code-like placeholder is not evaluated", v({ kind: "template", template: "{{item.constructor.constructor('globalThis.__pwned=true')()}}" }) === "" && globalThis.__pwned === false);
assert("validate: quoted key inside a JSON column", validateSource({ kind: "product", path: 'specifications.values["Assay %"]' }).length === 0);
assert("validate: filter path", validateSource({ kind: "product", path: 'activeIngredients[name="Vitamin E"].concentration' }).length === 0);
assert("validate: legacy spec spelling", validateSource({ kind: "product", path: "specifications.values.Assay %" }).length === 0);
assert("validate: item.extra key", validateSource({ kind: "item", path: 'extra["Lot"]' }).length === 0);
assert("validate: a path inside a scalar column → refused", validateSource({ kind: "product", path: "name.first" }).length === 1);
assert("validate: unknown column → refused", validateSource({ kind: "product", path: 'nothing["x"]' }).length === 1);
assert("validate: malformed → refused", validateSource({ kind: "product", path: 'specifications.values["pH' }).length === 1);
assert("validate: forbidden key → refused", validateSource({ kind: "product", path: "specifications.__proto__" }).length === 1);
assert("validate: combination with a grammar placeholder", validateSource({ kind: "template", template: 'COA {{product.activeIngredients[name="Vitamin E"].concentration}}' }).length === 0);
assert("validate: combination with an unknown grammar placeholder → refused", validateSource({ kind: "template", template: '{{product.name["x"]}}' }).length === 1);
assert("template regex still matches the V2 forms", [..."COA{{item.batchNo}}-{{today}}".matchAll(TEMPLATE_TOKEN_RE)].length === 2);

await finish(counts);
