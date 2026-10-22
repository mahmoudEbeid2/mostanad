// Certificate AI layers A1 — pure parts of template field mapping (plan.md §5,
// §10): label proposal (same line, column header, row label), batch-result
// recognition, date/case inference, dictionary matching, and the code
// validation of AI answers (invalid paths, fabricated values, deferred kinds).
// No API, no database.
import { makeAssert, finish } from "./helpers.js";
import { proposeLabel, sameLineLabel, looksLikeBatchResult, normLabel, slugKey } from "../../src/services/certificates/mapping/labelProposal.js";
import { inferDateFormat, inferCase, inferFormat } from "../../src/services/certificates/mapping/formatInference.js";
import { matchLabel, canonLabel } from "../../src/services/certificates/mapping/dictionaryMatch.js";
import { validateAiField, promptDictionary } from "../../src/services/certificates/mapping/fieldMapper.js";
import { observeProducts, schemaEntries } from "../../src/services/certificates/dictionary/dataDictionary.js";

const { assert, counts } = makeAssert();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n🧪 Label proposal — same line (§5.1 step 2)");
assert('"Batch No.:  AVVS1122005" → "Batch No."', sameLineLabel("Batch No.:  AVVS1122005", 12) === "Batch No.");
assert('"Document #: COA…" → "Document"', sameLineLabel("Document #: COAAVVS1122005  •  Issue Date: 05/02/2023", 12) === "Document");
const docLine = "Document #: COAAVVS1122005  •  Issue Date: 05/02/2023";
assert("second pair on a line: Issue Date", sameLineLabel(docLine, docLine.indexOf("05/02")) === "Issue Date");
assert("no colon → no same-line label", sameLineLabel("pH 3.0-5.0 4.0", 11) === null);
assert("nothing before → null", sameLineLabel("09/2028", 0) === null);
assert("digits-only chunk is not a label", sameLineLabel("12: 4.0", 4) === null);

console.log("\n🧪 Label proposal — layout context");
const P = (header, cells, idx, lineText = "x") => proposeLabel({ lineText, charStart: 0, context: { columnHeader: header, rowCells: cells, rowIndex: idx } });
assert("column header EXPIRATION DATE → “Expiration date”", eq(P("EXPIRATION DATE", ["DOXYPHARMA", "09/2028", "PHARMAVET"], 1), { label: "Expiration date", from: "column_header" }));
assert("mixed-case header kept as printed", P("Batch Size", ["564 KG"], 0).label === "Batch Size");
assert("generic header + row label: pH + Results → “pH result”", eq(P("Results", ["pH", "3.0-5.0", "4.0"], 2), { label: "pH result", from: "row_label" }));
assert("generic header + row label: Producer under SPECIFICATIONS → “Producer”", P("SPECIFICATIONS", ["Producer", "PHARMAVET", "—"], 1).label === "Producer");
assert("generic header, the value is the row label → null (AI names it)", P("Specifications", ["Sodium selenite", "60 mg"], 0).label === null);
assert("PDF ligature in a header (Speciﬁcations) is still generic", P("Speciﬁcations", ["Sodium selenite", "60 mg"], 0).label === null);
assert("same line wins over a header", proposeLabel({ lineText: "Batch No.:  X1", charStart: 12, context: { columnHeader: "LOT", rowCells: [], rowIndex: 0 } }).label === "Batch No.");
assert("nothing → null", eq(proposeLabel({ lineText: "4.0", charStart: 0, context: { columnHeader: null, rowCells: ["4.0"], rowIndex: 0 } }), { label: null, from: null }));

console.log("\n🧪 Per-batch results (batch_data)");
const B = (header, cells, idx) => looksLikeBatchResult({ context: { columnHeader: header, rowCells: cells, rowIndex: idx } });
assert("description | spec range | RESULT → batch_data", B("Results", ["pH", "3.0-5.0", "4.0"], 2) && B("RESULTS", ["pH", "2.0 – 3.0", "2.6"], 2));
assert("assay with a % spec → batch_data", B("Results", ["Assay", "90-110% of the labeled amount", "102.7%"], 2));
assert("a Results column holding a constituent amount is NOT batch_data", !B("Results", ["Sodium selenite", "60 mg"], 1) && !B("RESULTS", ["Constituents (per gm)", "Doxycycline hyclate", "500 mg"], 2));
assert("not a result column → false", !B("EXPIRATION DATE", ["X", "Y", "09/2028"], 2));
assert("without layout, the label decides (“pH result”)", looksLikeBatchResult({ label: "pH result" }) && !looksLikeBatchResult({ label: "Batch number" }));

console.log("\n🧪 Labels → keys / memory keys");
assert("slugKey", slugKey("Batch No.") === "batch_no" && slugKey("pH result") === "ph_result" && slugKey("") === "field");
assert("normLabel ignores case and punctuation", normLabel("Batch No.:") === normLabel("batch  no") && normLabel("Exp. Date") === "exp date");
assert("canonLabel: No./Nr./Num. → number", canonLabel("Batch No.") === "batch number" && canonLabel("Lot Nr") === "lot number");

console.log("\n🧪 Format inference (§5.1 step 4)");
assert("11/2025 → MM/YYYY", inferDateFormat("11/2025").date === "MM/YYYY");
assert("09.2028 → MM.YYYY", inferDateFormat("09.2028").date === "MM.YYYY");
assert("25/02/2023 → DD/MM/YYYY (25 > 12)", inferDateFormat("25/02/2023").date === "DD/MM/YYYY");
assert("02/25/2023 → MM/DD/YYYY", inferDateFormat("02/25/2023").date === "MM/DD/YYYY");
const amb = inferDateFormat("05/02/2023");
assert("05/02/2023 → ambiguous, never guessed", amb.date === null && eq(amb.ambiguous, ["DD/MM/YYYY", "MM/DD/YYYY"]));
assert("2026-10-22 → YYYY-MM-DD", inferDateFormat("2026-10-22").date === "YYYY-MM-DD");
assert("15 Apr 2026 → DD MMM YYYY", inferDateFormat("15 Apr 2026").date === "DD MMM YYYY");
assert("APR-2026 → MMM-YYYY", inferDateFormat("APR-2026").date === "MMM-YYYY");
assert("13/2025 is not a month → not a date", inferDateFormat("13/2025") === null && inferDateFormat("AVVS1122005") === null);
assert("case: SUPPLEMENT → upper, liquid → lower, Mixed → none", inferCase("SUPPLEMENT") === "upper" && inferCase("liquid") === "lower" && inferCase("Light yellow") === null && inferCase("1L") === null);
assert("case: codes with digits are left alone (AVVS1122005, ADD-E120)", inferCase("AVVS1122005") === null && inferCase("ADD-E120") === null);
assert("inferFormat(date) keeps ambiguity for the user", eq(inferFormat("05/02/2023", "date"), { format: null, ambiguousDate: ["DD/MM/YYYY", "MM/DD/YYYY"] }));
assert("inferFormat(string) → case only", eq(inferFormat("JORDAN", "string"), { format: { case: "upper" } }));

console.log("\n🧪 Dictionary match (§5.2 step 2)");
const products = [
  { name: "ADD-E120", producer: "AFAQ", origin: "JORDAN", activeIngredients: [{ name: "Vitamin E", concentration: "120000 mg" }], specifications: { values: { pH: "3.0-5.0" } } },
  { name: "DOXY", producer: "PHARMAVET", activeIngredients: [{ name: "Doxycycline", concentration: "500 mg" }], specifications: { values: { PH: "2.0" } } },
];
const entries = [...schemaEntries(products), ...observeProducts(products, ["activeIngredients", "specifications"])];
const M = (label, sampleValue, sampleCtx = null) => matchLabel({ label, sampleValue, entries, sampleCtx });
assert("“Batch No.” → item.batchNo", M("Batch No.", "AVVS1122005")?.entry?.path === "item.batchNo");
assert("“Expiration date” (synonym) → item.expiryDate", M("Expiration date", "09/2028")?.entry?.path === "item.expiryDate");
assert("“Manufacturing date” → item.productionDate", M("Manufacturing date", "09/2025")?.entry?.path === "item.productionDate");
assert("“Product Name” → product.name (not brand/category name)", M("Product Name", "ADD-E120")?.entry?.path === "product.name", M("Product Name", "ADD-E120"));
assert("“Producer” → product.producer", M("Producer", "AFAQ")?.entry?.path === "product.producer");
assert("“pH” → the observed specifications key", M("pH", "3.0-5.0")?.entry?.path === "product.specifications.values.pH");
assert("a date label with a non-date sample is not matched", M("Expiry date", "SEE PACK") === null);
assert("“Name” is ambiguous (product/company/brand…) → no guess", Array.isArray(M("Name", "X")?.ambiguous));
assert("unknown label → null", M("Document", "COA1") === null);
const ctx = { product: { ...products[0], brand: null } };
assert("sample product agrees → confidence 0.98", M("Product Name", "ADD-E120", ctx).confidence === 0.98);
assert("sample product disagrees → not used (goes to the AI)", !M("Product Name", "SOMETHING ELSE", ctx)?.entry);

console.log("\n🧪 Validation of AI answers (P1, P5)");
const field = { key: "k", sampleValue: "60 mg" };
const V = (a, f = field) => validateAiField({ category: "product_data", confidence: 0.8, rationale: "r", ...a }, f, entries);
assert("a dictionary path is accepted", eq(V({ sourceKind: "product", path: "product.producer" }).source, { kind: "product", path: "producer" }));
assert("a path given without its root is accepted", eq(V({ sourceKind: "product", path: "producer" }).source, { kind: "product", path: "producer" }));
assert("an invented path is refused", V({ sourceKind: "product", path: "product.potency" }).invalid?.includes("not in the company's data dictionary"));
assert("a path into another root's data is refused", !!V({ sourceKind: "company", path: "company.secret" }).invalid);
assert("an element of an observed collection by index is accepted", eq(V({ sourceKind: "product", path: "activeIngredients[1].concentration" }).source, { kind: "product", path: "activeIngredients[1].concentration" }));
assert('… and by [name="…"] even when not a listed name', !V({ sourceKind: "product", path: 'activeIngredients[name="Iron"].concentration' }).invalid);
assert("an unobserved child of a collection is refused", !!V({ sourceKind: "product", path: "activeIngredients[0].potency" }).invalid);
assert("fixed text must equal the printed sample (no invented content)", !!V({ sourceKind: "static", text: "70 mg" }).invalid && !V({ sourceKind: "static", text: "60 mg" }).invalid);
assert("a combination with an invented placeholder is refused", !!V({ sourceKind: "template", template: "COA{{item.lotCode}}" }).invalid);
assert("a valid combination is accepted", eq(V({ sourceKind: "template", template: "COA{{item.batchNo}}" }, { key: "d", sampleValue: "COAX1" }).source, { kind: "template", template: "COA{{item.batchNo}}" }));
assert("a combination without placeholders is refused", !!V({ sourceKind: "template", template: "COA" }).invalid);
const pt = V({ sourceKind: "product_text", path: "product.appearance", extractLabel: "pH" });
assert("product_text → kept as a proposal, field stays manual until A2", !pt.invalid && pt.source.kind === "manual" && /A2/.test(pt.note), pt);
assert("unknown sourceKind refused", !!V({ sourceKind: "eval" }).invalid);
assert("confidence is clamped", V({ sourceKind: "manual", confidence: 7 }).confidence === 1 && V({ sourceKind: "manual", confidence: -1 }).confidence === 0);
assert("an unknown category becomes unknown", V({ sourceKind: "manual", category: "secret" }).category === "unknown");
assert("a bad date format from the model is replaced by the inferred one", eq(V({ sourceKind: "item", path: "item.expiryDate", dateFormat: "QQ/ZZ" }, { key: "e", sampleValue: "11/2025" }).format, { date: "MM/YYYY" }));
assert("an invalid answer carries no source but manual", eq(V({ sourceKind: "product", path: "product.nope" }).source, { kind: "manual" }));

console.log("\n🧪 Prompt dictionary");
const pd = promptDictionary(entries);
assert("≤ 200 entries, invoice/company paths first", pd.length <= 200 && pd[0].path.startsWith("item.") === true);
assert("only the fields the model needs (no internal flags)", pd.every((e) => !("pickable" in e) && !("source" in e)));

await finish(counts);
