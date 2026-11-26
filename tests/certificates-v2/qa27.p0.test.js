// 27 Nov production QA, P0 — wrong content on certificates (pure, no stack needed):
//   1 FSC: the sample's 17-row table is ONE repeating row (No / Item / Packing / FORM / CATEGORY), its
//     numbering continues the sample's own (FSCAVIV22-066 → FSCAVIV{YY}-{SEQ3})
//   2 COA rows no rule marked (Sterility / Pyrogen): spec + result fields, never the sample's "Conforms"
//   3 COA constituents: "10,000,000 I.U." is an amount (not a name); amount + unit ONE cell in the column's alignment
//   4 a specification never holds a result word
//   5 a result outside its specification is caught
//   6/7 the MO's dates ("Oct-26") are read; a batch size is never an MO quantity
import { makeAssert } from "./helpers.js";
import { numberedTable, headerColumns, splitRow } from "../../src/services/certificates/templates/productTable.js";
import { fieldsForAreas, testRowFields } from "../../src/services/certificates/templates/autoMap.js";
import { numberPattern } from "../../src/services/harvest/harvestRules.js";
import { formatNumber } from "../../src/services/certificates/generation/docNumbers.js";
import { isoOf, parseBatchLine } from "../../src/services/certificates/generation/batchAnswer.js";
import { applyFormat, resolveField } from "../../src/services/certificates/generation/valueResolver.js";
import { cleanSpec } from "../../src/services/harvest/productForm.js";
import { inSpec } from "../../src/services/certificates/labResults/specCheck.js";
import { FSC_LINES } from "../fixtures/addvetFscLines.js";

const { assert, counts } = makeAssert();
const by = (fields) => Object.fromEntries(fields.map((f) => [f.key, f]));

console.log("1 · FSC");
const t = numberedTable(FSC_LINES);
const cells = by(t.fields || []);
assert("the 17 sample rows → ONE repeating row over the request's lines", t.rows === 17 && t.group?.source?.kind === "invoice_lines" && t.group.sampleRows === 17, t.problem || t.rows);
assert("its columns: No (the row's place), Item, Packing, FORM, CATEGORY", cells.row_no?.source.path === "lineNo" && cells.row_product_name?.source.path === "product.name" && cells.row_cell_pack?.source.path === "packing" && cells.row_cell_form?.source.path === "product.physicalForm" && cells.row_cell_category?.source.path === "product.category.name", Object.values(cells).map((c) => `${c.key}:${c.source.path}`));
assert("no batch field among them", !Object.values(cells).some((c) => /batch/i.test(c.key + c.source.path)));
assert("a multi-word name / category splits right («LYSINE HCL» · «100GM» · «POWDER» · «FEED ADDITIVES»)", JSON.stringify(splitRow("2 LYSINE HCL 100GM POWDER FEED ADDITIVES", headerColumns("No Item Packing FORM CATEGORY"))) === JSON.stringify({ no: [0, 1], name: [2, 12], pack: [13, 18], form: [19, 25], category: [26, 40] }));
assert("a line of words that aren't all column names is no header", headerColumns("We hereby certify that the products below") === null);
const n = numberPattern("FSCAVIV22-066", "06/11/2022");
assert("numbering: FSCAVIV22-066 (06/11/2022) → FSCAVIV{YY}-{SEQ3}, next FSCAVIV26-067", n?.pattern === "FSCAVIV{YY}-{SEQ3}" && n.seq === 66 && formatNumber(n.pattern, n.seq + 1, new Date(2026, 10, 27)) === "FSCAVIV26-067", n);
assert("the COA's own numbering is unchanged", numberPattern("COAAVVI0926001", "23/09/2026")?.pattern === "COAAVVI{MM}{YY}{SEQ3}");

console.log("2 · COA rows no rule marked");
const L = (id, y, text, x = 74, w = 515) => ({ id, page: 1, text, box: { x, y, w, h: 12 } });
const coaRows = [L("app", 417, "Appearance Light yellow liquid Conforms"), L("ste", 812, "Sterility Sterile Conforms"), L("pyr", 839, "Pyrogen Non-pyrogenic Conforms"), L("pro", 892, "Producer AFAQ Additives Feed Company —")];
const tr = by(testRowFields(coaRows, new Set(["app"])));
assert("Sterility / Pyrogen: their result is a lab result field (never the sample's «Conforms»)", tr.result_sterility?.isLabResult && tr.result_pyrogen?.isLabResult && tr.result_sterility.source.kind === "manual", Object.keys(tr));
assert("their specification is the product's", tr.spec_sterility?.source.path === "specifications.values.Sterility" && tr.spec_pyrogen?.sampleValue === "Non-pyrogenic");
assert("a line already mapped, or not a test row, is left alone", !Object.values(tr).some((f) => ["app", "pro"].includes(f.lineId)));
assert("«N/A» answers a result the product doesn't need", parseBatchLine("ADDHEPA Sterility N/A", { products: ["ADDHEPA"], tests: ["Sterility"] })[0]?.results?.sterility === "N/A");

console.log("3 · constituents");
const comp = [
  L("h", 494, "Constituents (per Litre) Vitamin A", 74, 224),
  L("a1", 494, "10,000,000 I.U.", 535, 84),
  L("n2", 510, "Vitamin D3", 245, 61),
  L("a2", 510, "2,000,000 I.U.", 535, 77),
  L("n3", 526, "Vitamin E", 245, 52),
  L("a3", 526, "2,000 mg", 535, 53),
  L("s", 812, "Sterility Sterile Conforms"),
];
const areas = [
  { lineId: "h", page: 1, kind: "value", label: "Value", text: "Vitamin A", charStart: 25, charEnd: 34 },
  { lineId: "a1", page: 1, kind: "quantity", label: "Quantity / pack", text: "10,000,000 I.U.", charStart: 0, charEnd: 15 },
  { lineId: "n2", page: 1, kind: "value", label: "Value", text: "Vitamin D3", charStart: 0, charEnd: 10 },
  { lineId: "a2", page: 1, kind: "quantity", label: "Quantity / pack", text: "2,000,000 I.U.", charStart: 0, charEnd: 14 },
  { lineId: "n3", page: 1, kind: "value", label: "Value", text: "Vitamin E", charStart: 0, charEnd: 9 },
  { lineId: "a3", page: 1, kind: "quantity", label: "Quantity / pack", text: "2,000 mg", charStart: 0, charEnd: 8 },
];
const cf = by(fieldsForAreas(areas, comp));
assert("«10,000,000 I.U.» is ingredient 1's amount, not a name (it printed «Sorbitol»)", cf.comp_0_amount?.sampleValue === "10,000,000 I.U." && cf.comp_0_amount.source.path === "activeIngredients[0].amountText" && !Object.values(cf).some((f) => /name/.test(f.key) && /I\.U\./.test(f.sampleValue)), Object.values(cf).map((f) => `${f.key}=${f.sampleValue}`));
assert("each amount is ONE cell with its unit", ["comp_0_amount", "comp_1_amount", "comp_2_amount"].every((k) => cf[k]?.source.path.endsWith("amountText")) && !Object.values(cf).some((f) => /_unit$/.test(f.key)));
assert("the column's alignment: amounts starting at one x (535) → left", ["comp_0_amount", "comp_1_amount", "comp_2_amount"].every((k) => cf[k]?.align === "left"));
const p = { activeIngredients: [{ name: "Sorbitol", concentration: "350,000 mg" }] };
assert("the cell prints the amount with its unit", resolveField(cf.comp_0_amount, { product: p }).value === "350,000 mg");
const right = by(
  fieldsForAreas(
    [
      { lineId: "r1", page: 1, kind: "quantity", label: "Value", text: "10 mg", charStart: 0, charEnd: 5 },
      { lineId: "r2", page: 1, kind: "quantity", label: "Value", text: "2,000 mg", charStart: 0, charEnd: 8 },
    ],
    [L("hh", 300, "Composition: Each 1 mL contains:", 69, 200), L("r1", 316, "10 mg", 360, 30), L("r2", 332, "2,000 mg", 337, 53)],
  ),
);
assert("amounts whose right edges line up → right", right.comp_0_amount?.align === "right" && right.comp_1_amount?.align === "right", Object.values(right).map((f) => `${f.key}:${f.align}`));
const basis = by(fieldsForAreas([{ lineId: "b", page: 1, kind: "basis", label: "Composition basis", text: "Each 1 L contains:", charStart: 0, charEnd: 18 }], [L("b", 353, "Each 1 L contains:", 69, 101)]));
assert("«Each 1 L contains:» — the colon stays the design's", basis.composition_basis?.sampleValue === "Each 1 L contains", basis.composition_basis);

console.log("4 · a specification never holds a result");
assert("«Light brown liquid Conforms Positive to HPLC test» → «Light brown liquid»", cleanSpec("Light brown liquid Conforms Positive to HPLC test") === "Light brown liquid");
assert("a real specification stays whole («Positive to HPLC test», «3.0 - 6.0»)", cleanSpec("Positive to HPLC test") === "Positive to HPLC test" && cleanSpec("3.0 - 6.0") === "3.0 - 6.0");

console.log("5 · out of specification");
assert("pH 7.5 against «3.0 – 6.0» is outside", inSpec("7.5", "3.0 – 6.0") === false && inSpec("4.8", "3.0 – 6.0") === true);

console.log("6/7 · the MO's batch facts");
assert("«Oct-26» / «Oct-29» → 10/2026, 10/2029 (as the template prints month/year)", applyFormat(isoOf("Oct-26"), { date: "MM/YYYY" }).value === "10/2026" && applyFormat(isoOf("Oct-29"), { date: "MM/YYYY" }).value === "10/2029");
assert("a batch size keeps its unit («240 KG»)", parseBatchLine("OLIGOVET حجم 240 KG", { products: ["OLIGOVET"] })[0]?.batchSize === "240 KG");

console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
process.exit(counts.failed ? 1 : 0);
