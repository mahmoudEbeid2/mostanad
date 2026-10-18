// Certificates V2 §16.3 — valueResolver: every source kind, `template`
// interpolation (must never evaluate code), formats, missing values (D7).
// Pure functions: no API, no database.
import { makeAssert, finish } from "./helpers.js";
import { resolveField, applyFormat, readPath, formatDate } from "../../src/services/certificates/generation/valueResolver.js";
import { validateSource, validateFormat } from "../../src/services/certificates/templates/sourceCatalogue.js";

const { assert, counts } = makeAssert();

const ctx = {
  item: { batchNo: "AVVS1124011", expiryDate: "2027-06", productionDate: "2024-06-15", quantity: 12500.5, name: "ADD-E120" },
  invoice: { invoiceNumber: "INV-77", invoiceDate: { raw: "15/06/2024", iso: "2024-06-15" }, customerCountry: "SA" },
  product: {
    name: "ADD-E120",
    producer: "ADDVET",
    targetSpecies: ["Poultry", "Cattle"],
    activeIngredients: [{ name: "Vitamin E", concentration: "120000 mg" }, { name: "Sodium selenite", concentration: "60 mg" }],
    category: { name: "Supplement" },
    brand: { name: "ADDvet" },
    specifications: { values: { pH: "3.0-5.0" } },
  },
  company: { name: "ADDVET Animal Health", address: "Amman" },
  today: new Date("2026-10-17T10:00:00Z"),
};
const v = (source, format = null) => resolveField({ key: "k", source, format }, ctx);

console.log("\n🧪 Source kinds");
assert("item", v({ kind: "item", path: "batchNo" }).value === "AVVS1124011");
assert("invoice (raw string)", v({ kind: "invoice", path: "invoiceNumber" }).value === "INV-77");
assert("invoice date { raw, iso } → iso", v({ kind: "invoice", path: "invoiceDate" }).value === "2024-06-15");
assert("product scalar", v({ kind: "product", path: "producer" }).value === "ADDVET");
assert("product list → joined", v({ kind: "product", path: "targetSpecies" }).value === "Poultry, Cattle");
assert("product ingredient [1].concentration", v({ kind: "product", path: "activeIngredients[1].concentration" }).value === "60 mg");
assert("product relation category.name", v({ kind: "product", path: "category.name" }).value === "Supplement");
assert("product specifications.values.pH", v({ kind: "product", path: "specifications.values.pH" }).value === "3.0-5.0");
assert("brand (product's brand)", v({ kind: "brand", path: "name" }).value === "ADDvet");
assert("company", v({ kind: "company", path: "name" }).value === "ADDVET Animal Health");
assert("static", v({ kind: "static", text: "JORDAN" }).value === "JORDAN");
assert("manual → empty at generation", v({ kind: "manual" }).value === "");
assert("today → generation date", v({ kind: "today" }).value === "2026-10-17");

console.log("\n🧪 Missing values (D7: empty, never invented)");
assert("missing item path → empty", v({ kind: "item", path: "packing" }).value === "");
assert("missing ingredient slot → empty", v({ kind: "product", path: "activeIngredients[5].name" }).value === "");
assert("no product in context → empty", resolveField({ source: { kind: "product", path: "name" } }, { today: ctx.today }).value === "");
assert("object value (not representable) → empty", v({ kind: "product", path: "specifications" }).value === "");

console.log("\n🧪 Template interpolation — never evaluates");
assert("COA{{item.batchNo}}", v({ kind: "template", template: "COA{{item.batchNo}}" }).value === "COAAVVS1124011");
assert("several placeholders + today", v({ kind: "template", template: "{{invoice.invoiceNumber}}/{{item.batchNo}} @ {{today}}" }).value === "INV-77/AVVS1124011 @ 2026-10-17");
assert("a missing placeholder empties the whole value", v({ kind: "template", template: "COA{{item.packing}}" }).value === "");
globalThis.__pwned = false;
const evil = v({ kind: "template", template: "{{item.constructor.constructor('globalThis.__pwned=true')()}}" });
assert("code-like placeholder is not evaluated", globalThis.__pwned === false && evil.value === "");
assert("readPath never walks into functions' code", readPath({ a: { b: 1 } }, "a.b") === 1 && readPath(ctx, "__proto__.polluted") === undefined);
assert("validateSource rejects unknown kinds in a combination", validateSource({ kind: "template", template: "{{process.env.SECRET}}" }).length > 0);
assert("validateSource rejects a combination without placeholders", validateSource({ kind: "template", template: "COA" }).length > 0);
assert("validateSource rejects an unknown product path", validateSource({ kind: "product", path: "password" }).length > 0);
assert("validateSource accepts the plan's example", validateSource({ kind: "template", template: "COA{{item.batchNo}}" }).length === 0);

console.log("\n🧪 Formats");
assert("date MM/YYYY from month-precision ISO", v({ kind: "item", path: "expiryDate" }, { date: "MM/YYYY" }).value === "06/2027");
assert("date DD MMM YYYY", v({ kind: "item", path: "productionDate" }, { date: "DD MMM YYYY" }).value === "15 Jun 2024");
assert("date YY", v({ kind: "today" }, { date: "DD/MM/YY" }).value === "17/10/26");
const noDay = v({ kind: "item", path: "expiryDate" }, { date: "DD/MM/YYYY" });
assert("DD on a month-only date → raw kept + format flag (never invent a day)", noDay.value === "2027-06" && noDay.flags.includes("format"), noDay);
const raw = applyFormat("11/2025", { date: "MM/YYYY" });
assert("non-ISO date → raw kept + format flag", raw.value === "11/2025" && raw.flags.includes("format"));
assert("invalid month rejected", formatDate("2025-13", "MM/YYYY").error === true);
assert("number decimals + thousands", v({ kind: "item", path: "quantity" }, { number: { decimals: 2, thousands: "," } }).value === "12,500.50");
assert("case upper / title", applyFormat("sodium selenite", { case: "upper" }).value === "SODIUM SELENITE" && applyFormat("sodium selenite", { case: "title" }).value === "Sodium Selenite");
assert("prefix / suffix", applyFormat("60", { prefix: "≈ ", suffix: " mg" }).value === "≈ 60 mg");
assert("format never applies to an empty value", applyFormat("", { prefix: "COA" }).value === "");
assert("validateFormat: date on a string source rejected", validateFormat({ date: "MM/YYYY" }, { kind: "item", path: "batchNo" }).length > 0);
assert("validateFormat: bad date pattern rejected", validateFormat({ date: "MM/YYYY <script>" }, { kind: "item", path: "expiryDate" }).length > 0);
assert("validateFormat: number on a date source rejected", validateFormat({ number: { decimals: 2 } }, { kind: "today" }).length > 0);

await finish(counts);
