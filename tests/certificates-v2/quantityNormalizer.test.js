// Review #4 — invoice quantities: a lone "." or "," followed by exactly three
// digits could be a thousands or a decimal separator → null + raw kept +
// flagged, like an ambiguous date. Pure functions: no API, no database.
import { makeAssert, finish } from "./helpers.js";
import { normalizeQuantity } from "../../src/services/certificates/invoices/quantityNormalizer.js";
import { shapeExtraction } from "../../src/services/certificates/invoices/invoiceExtractor.js";

const { assert, counts } = makeAssert();
const q = (raw) => normalizeQuantity(raw);
const is = (raw, value) => {
  const r = q(raw);
  assert(`"${raw}" → ${value}`, r.value === value && !r.ambiguous, r);
};
const ambiguous = (raw) => {
  const r = q(raw);
  assert(`"${raw}" → null, ambiguous`, r.value === null && r.ambiguous === true, r);
};

console.log("\n🧪 US format (, thousands · . decimal)");
is("1,250.50", 1250.5);
is("12,500,000", 12500000);
is("12,500,000.25", 12500000.25);
is("0.5", 0.5);
is("12.50", 12.5);
is("1250", 1250);

console.log("\n🧪 European format (. thousands · , decimal)");
is("1.250,50", 1250.5);
is("12.500.000", 12500000);
is("12.500.000,25", 12500000.25);
is("12,5", 12.5);
is("1 250,5", 1250.5);
is("1 250", 1250);
is("1 250,75", 1250.75);

console.log("\n🧪 Ambiguous: one separator + exactly 3 digits");
ambiguous("1.250");
ambiguous("1,250");
ambiguous("12.500");
ambiguous("999,000");
console.log("\n🧪 …but not when a thousands group is impossible");
is("0,250", 0.25); // "0,250" is never 250
is("1250.500", 1250.5); // 4 digits before the separator: no grouping
is("1.25", 1.25);
is("1,2500", 1.25);

console.log("\n🧪 Not a number → null, not ambiguous");
for (const raw of ["25 KG", "1,25,000", "1.250.5", "1,", "", null, "abc", "1.250,500.5"]) {
  const r = q(raw);
  assert(`${JSON.stringify(raw)} → null`, r.value === null && r.ambiguous === false, r);
}
is("-3,5", -3.5);
assert("a number passes through", q(42).value === 42 && !q(42).ambiguous);

console.log("\n🧪 Extraction keeps the raw text and flags the line");
const shaped = shapeExtraction({
  header: {},
  items: [
    { lineNo: 1, quantity: "1.250" },
    { lineNo: 2, quantity: "1.250,00" },
    { lineNo: 3, quantity: "1,250.00" },
  ],
});
const [a, b, c] = shaped.items.map((x) => x.data);
assert("ambiguous line: quantity null, raw kept, quantityAmbiguous", a.quantity === null && a.quantityRaw === "1.250" && a.quantityAmbiguous === true, a);
assert("European line → 1250, no flag", b.quantity === 1250 && b.quantityRaw === "1.250,00" && !("quantityAmbiguous" in b), b);
assert("US line → 1250, no flag", c.quantity === 1250 && !("quantityAmbiguous" in c), c);

finish(counts);
