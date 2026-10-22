// Certificate AI layers — Phase A2 units (plan.md §6, §10): evidence
// verification (normalisation: whitespace, case, unicode dashes, Turkish İ;
// row scope; product paths; product text), item row spans, near-miss keys,
// stored values, extraction hints, accepted path synonyms in the resolver,
// the "generate anyway" permission rule. Pure — no stack needed.
import { makeAssert, finish } from "./helpers.js";
import { normalizeEvidence, normalizeWithMap, findOccurrences, verifyEvidence, verifyAnswer, pageAt } from "../../src/services/certificates/dataNeeds/evidenceVerifier.js";
import { locateItemSpans } from "../../src/services/certificates/dataNeeds/itemSpans.js";
import { nearMisses } from "../../src/services/certificates/dataNeeds/gapResolver.js";
import { storedValue } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { hintText, shapeExtraction } from "../../src/services/certificates/invoices/invoiceExtractor.js";
import { resolveField } from "../../src/services/certificates/generation/valueResolver.js";
import { resolveWithNeed } from "../../src/services/certificates/generation/batchService.js";
import { canonicalFull } from "../../src/services/certificates/paths/sourcePath.js";
import { mayDo } from "../../src/controllers/certificatesV2/requestScope.js";

const { assert, counts } = makeAssert();

console.log("\n🧪 Evidence normalisation (§10)");
assert("case + whitespace collapse", normalizeEvidence("  Batch   No:\tAVVS  ") === "batch no: avvs");
assert("unicode dashes → '-'", normalizeEvidence("2.0 – 3.0 — x ‒ y − z") === "2.0 - 3.0 - x - y - z");
assert("Turkish İ / ı / I / i compare equal", normalizeEvidence("İÇ VE DIŞ TİCARET") === normalizeEvidence("iç ve diş ticaret") && normalizeEvidence("İ") === "i" && normalizeEvidence("ı") === "i");
assert("accents fold (Ç → c)", normalizeEvidence("İÇ") === "ic");
assert("' | ' cell separators read as spaces", normalizeEvidence("HSPhar02609001 | 09/2026") === normalizeEvidence("HSPhar02609001 09/2026"));
assert("ligatures (NFKC): ﬁ → fi", normalizeEvidence("Speciﬁcation") === "specification");
const m = normalizeWithMap("A  –  B");
assert("index map points back into the original", m.text === "a - b" && m.map[2] === 3, m);
const occ = findOccurrences("x\nBatch: AB-1\nBatch: AB-1", "batch:  ab–1");
assert("occurrences found in original offsets (both)", occ.length === 2 && "x\nBatch: AB-1\nBatch: AB-1".slice(occ[1].start, occ[1].end) === "Batch: AB-1", occ);
assert("pageAt reads === Page N === markers", pageAt("=== Page 1 ===\na\n=== Page 2 ===\nb", 20) === 2 && pageAt("=== Page 1 ===\na", 3) === 1);

console.log("\n🧪 verifyEvidence — invoice_text (P2) and row scope");
const TEXT = "=== Page 1 ===\nHealth Cert. No: HC-77\n1 | ADD-E120 | AVVS1 | pH 4.1\n2 | ADD-SE | AVSE2 | pH 5.2\n=== Page 2 ===\nTotal";
const row1 = { start: TEXT.indexOf("1 | ADD-E120"), end: TEXT.indexOf("pH 4.1") + 6 };
const row2 = { start: TEXT.indexOf("2 | ADD-SE"), end: TEXT.indexOf("pH 5.2") + 6 };
const item1 = { textContent: TEXT, scope: "item", span: row1, otherSpans: [row1, row2], singleItem: false };
let r = verifyEvidence({ type: "invoice_text", quote: "pH 4.1" }, { ...item1, value: "4.1" });
assert("quote in the line's own row → verified, with page + offsets", r.ok && r.provenance.page === 1 && TEXT.slice(r.provenance.start, r.provenance.end) === "pH 4.1", r);
r = verifyEvidence({ type: "invoice_text", quote: "pH 5.2" }, { ...item1, value: "5.2" });
assert("a real value from ANOTHER line's row → rejected", !r.ok && /row/.test(r.reason), r);
r = verifyEvidence({ type: "invoice_text", quote: "pH 4.7" }, { ...item1, value: "4.7" });
assert("a plausible value not in the text → rejected", !r.ok && /not in the invoice text/.test(r.reason), r);
r = verifyEvidence({ type: "invoice_text", quote: "pH 4.1" }, { ...item1, value: "4.0" });
assert("the quote is there but the value isn't in it → rejected", !r.ok && /not inside the quote/.test(r.reason), r);
r = verifyEvidence({ type: "invoice_text", quote: "pH 4.1" }, { ...item1, span: null, value: "4.1" });
assert("several lines and no row for this one → rejected (can't tie it)", !r.ok && /could not be located/.test(r.reason), r);
r = verifyEvidence({ type: "invoice_text", quote: "Total" }, { textContent: TEXT, scope: "item", span: null, otherSpans: [], singleItem: true, value: "Total" });
assert("one line only → its value may be printed anywhere (page 2)", r.ok && r.provenance.page === 2, r);
const header = { textContent: TEXT, scope: "header", otherSpans: [row1, row2], singleItem: false };
r = verifyEvidence({ type: "invoice_text", quote: "Health Cert. No: HC-77" }, { ...header, value: "HC-77" });
assert("header value outside every item row → verified", r.ok, r);
r = verifyEvidence({ type: "invoice_text", quote: "AVVS1" }, { ...header, value: "AVVS1" });
assert("header value quoted from inside an item row → rejected", !r.ok && /item row/.test(r.reason), r);
r = verifyEvidence({ type: "invoice_text", quote: "x" }, { ...header, textContent: null, value: "x" });
assert("no stored invoice text → rejected", !r.ok);

console.log("\n🧪 verifyEvidence — product_path (P1) / product_json_text");
const product = { name: "ADD-COMPLEX", description: "Oral solution. Withdrawal period: 7 days for meat.", specifications: { values: { "PH value": "5.5-6.5" } }, activeIngredients: [{ name: "Vit E", concentration: "10 mg" }] };
r = verifyEvidence({ type: "product_path", path: 'specifications.values["PH value"]' }, { product, value: "9.9 (model)" });
assert("product_path: CODE's value replaces the model's", r.ok && r.value === "5.5-6.5" && r.provenance.path === 'product.specifications.values["PH value"]', r);
r = verifyEvidence({ type: "product_path", path: "specifications.values.nothing" }, { product, value: "1" });
assert("product_path to an empty/missing key → rejected", !r.ok, r);
r = verifyEvidence({ type: "product_path", path: "constructor" }, { product, value: "1" });
assert("product_path to a forbidden key → rejected", !r.ok, r);
r = verifyEvidence({ type: "product_path", path: "activeIngredients" }, { product, value: "x" });
assert("product_path to a list (not a value) → rejected", !r.ok, r);
r = verifyEvidence({ type: "product_path", path: "name" }, { product: null, value: "x" });
assert("no matched product → rejected", !r.ok);
r = verifyEvidence({ type: "product_json_text", path: "description", quote: "Withdrawal period: 7 days for meat" }, { product, value: "7 days for meat" });
assert("product_json_text: quote in the product's text, value in the quote → verified", r.ok && r.provenance.path === "product.description", r);
r = verifyEvidence({ type: "product_json_text", path: "description", quote: "Withdrawal period: 14 days" }, { product, value: "14 days" });
assert("product_json_text quote not in the product's string → rejected", !r.ok && /not in the product/.test(r.reason), r);
r = verifyEvidence({ type: "product_json_text", path: "description", quote: "Withdrawal period: 7 days for meat" }, { product, value: "9 days" });
assert("product_json_text value not in the quote → rejected", !r.ok, r);
r = verifyEvidence({ type: "made_up" }, { product, value: "x" });
assert("unknown evidence type → rejected", !r.ok);

console.log("\n🧪 verifyAnswer");
let v = verifyAnswer({ found: true, value: "4.1", evidence: [{ type: "invoice_text", quote: "pH 9" }, { type: "invoice_text", quote: "pH 4.1" }] }, item1);
assert("one proving entry is enough; every check kept", v.verified && v.checks.length === 2 && v.checks[0].ok === false, v);
v = verifyAnswer({ found: true, value: "x", evidence: [{ type: "invoice_text", quote: "pH 4.1" }, { type: "product_path", path: "name" }] }, { ...item1, product });
assert("a product_path proof wins (DB value)", v.verified && v.value === "ADD-COMPLEX", v);
assert("found:false → not verified", !verifyAnswer({ found: false }, item1).verified);
assert("found with no evidence → not verified", !verifyAnswer({ found: true, value: "4.1", evidence: [] }, item1).verified);

console.log("\n🧪 Item row spans (code decides; rowText is a hint)");
const T2 = "=== Page 1 ===\nNo | Product | Code | Batch\n1 | ADD-E120 1L | ADDE120 | B1\n2 | ADD-SE 1L | ADDSE | B2\n3 | ADD-SE 1L | ADDSE | B3";
let spans = locateItemSpans(T2, [
  { id: "a", data: { name: "ADD-E120 1L", code: "ADDE120" } },
  { id: "b", data: { name: "ADD-SE 1L", code: "ADDSE", batchNo: "B2" } },
  { id: "c", data: { name: "ADD-SE 1L", code: "ADDSE", batchNo: "B3" } },
]);
assert("by code", T2.slice(spans.get("a").start, spans.get("a").end) === "1 | ADD-E120 1L | ADDE120 | B1" && spans.get("a").via === "line_search");
assert("same code on two lines → the batch decides", T2.slice(spans.get("b").start, spans.get("b").end).endsWith("B2") && T2.slice(spans.get("c").start, spans.get("c").end).endsWith("B3"));
spans = locateItemSpans(T2, [{ id: "x", data: { name: "ADD-SE 1L" } }]);
assert("ambiguous (name on two lines, no batch) → no span", spans.get("x") === null);
spans = locateItemSpans(T2, [{ id: "r", data: {}, rowText: "2 | ADD-SE 1L | ADDSE | B2" }]);
assert("rowText found once → its span", spans.get("r")?.via === "row_text");
spans = locateItemSpans(T2, [{ id: "r", data: {}, rowText: "not in the text" }]);
assert("rowText not in the text → ignored (no invented span)", spans.get("r") === null);
spans = locateItemSpans(T2, [{ id: "p", data: { code: "ADDE120" } }, { id: "q", data: { name: "ADD-E120 1L" } }]);
assert("two lines claiming the same row → neither keeps it", spans.get("p") === null && spans.get("q") === null);
assert("no text → no spans", locateItemSpans(null, [{ id: "z", data: {} }]).get("z") === null);
const shaped = shapeExtraction({ textContent: "x", header: {}, items: [{ name: "A", rowText: "1 | A" }] });
assert("extraction keeps rowText beside (not inside) the line data", shaped.items[0].rowText === "1 | A" && !("rowText" in shaped.items[0].data));

console.log("\n🧪 Near-miss keys (§6.1)");
const nm = nearMisses(product, "product.specifications.values.pH", ["specifications", "activeIngredients"]);
assert('"PH value" is a near miss for pH', nm.some((x) => x.path === 'specifications.values["PH value"]' && x.value === "5.5-6.5"), nm);
assert("unrelated keys are not", !nearMisses({ specifications: { values: { Density: "1" } } }, "product.specifications.values.pH", ["specifications"]).length);

console.log("\n🧪 Stored values");
const dateField = { source: { kind: "item", path: "productionDate" }, format: { date: "MM/YYYY" } };
assert("a date → ISO when unambiguous", storedValue(dateField, "04/2026") === "2026-04");
assert("an ambiguous date stays as printed", storedValue(dateField, "03/04/2025") === "03/04/2025");
assert("text trimmed; empty → null", storedValue({ source: { kind: "manual" } }, "  4.1 ") === "4.1" && storedValue({ source: { kind: "manual" } }, "  ") === null);

console.log("\n🧪 Extraction hints (§6.3)");
const h = hintText({ line: [{ path: "productionDate", label: "Production date", synonyms: ["mfg date"] }], header: [], perLine: ["pH"] });
assert("hint names the needed columns and their printed variants", /Production date \(productionDate; may be printed as mfg date\)/.test(h) && /pH/.test(h), h);
assert("nothing needed → no hint", hintText(null) === null && hintText({ line: [], header: [], perLine: [] }) === null);

console.log("\n🧪 Accepted path synonyms in the resolver");
const phField = { source: { kind: "product", path: "specifications.values.pH" } };
const synCtx = { product, pathSynonyms: { [canonicalFull("product.specifications.values.pH")]: ['product.specifications.values["PH value"]'] } };
let rf = resolveField(phField, synCtx);
assert("empty declared path → the accepted alternative, with via", rf.value === "5.5-6.5" && rf.via === 'product.specifications.values["PH value"]', rf);
rf = resolveField(phField, { product });
assert("without the synonym → empty (never guessed)", rf.value === "");
rf = resolveField(phField, { product: { specifications: { values: { pH: "4-5", "PH value": "9" } } }, pathSynonyms: synCtx.pathSynonyms });
assert("the declared path wins when it has a value", rf.value === "4-5" && !rf.via);
rf = resolveField({ source: { kind: "template", template: "pH {{product.specifications.values.pH}}" } }, synCtx);
assert("placeholders use synonyms too", rf.value === "pH 5.5-6.5" && rf.via, rf);
assert("canonicalFull: values[\"pH\"] ≡ values.pH", canonicalFull('product.specifications.values["pH"]') === "product.specifications.values.pH" && canonicalFull("nope") === null);

console.log("\n🧪 Generation takes the check's value first (§4)");
const need = { id: "n1", status: "provided", value: "2026-04", provenance: { kind: "manual" } };
let w = resolveWithNeed(dateField, { item: { productionDate: { raw: "01/2020", iso: "2020-01" } } }, need);
assert("a provided value beats the source, formatted, with provenance", w.value === "04/2026" && w.origin === "data_check" && w.provenance.kind === "manual" && w.provenance.needId === "n1", w);
w = resolveWithNeed(dateField, { item: { productionDate: { raw: "01/2020", iso: "2020-01" } } }, null);
assert("no settled need → the declared source", w.value === "01/2020" && w.origin === "auto", w);

console.log("\n🧪 'Generate anyway' permission (update_certificates)");
assert("system user with the permission", mayDo({ headers: {}, user: { role: { permissions: [{ permission: { slug: "update_certificates" } }] } } }, "update_certificates") === true);
assert("system user without it", mayDo({ headers: {}, user: { role: { permissions: [{ permission: { slug: "create_certificates" } }] } } }, "update_certificates") === false);
assert("company tenant: the certificates module", mayDo({ headers: {}, company: { id: "c" }, user: { role: "company" } }, "update_certificates") === true);

await finish(counts);
