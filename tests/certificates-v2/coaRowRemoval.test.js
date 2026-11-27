// 28 Nov (owner), the COA rule (pure, no stack needed):
//   1 a COA test whose result is unknown — and an unknown batch size — is taken off, never printed blank;
//     a value brings its row back; other types are never touched
//   2 "N/A" is never printed for an unknown value; a test the product type doesn't have is empty on purpose
//   3 the card's one line, and the drafts' message, list what was taken off
//   4 experiment mode: a batch size is pack × quantity, never the count with a volume unit
import { makeAssert } from "./helpers.js";
import { rowsToRemove, applyRemovedRows, removedKeys, removedLineAr, rowName, ROW_REMOVED } from "../../src/services/certificates/labResults/rowRemoval.js";
import { resolveWithNeed, emptyOnPurpose, isNA } from "../../src/services/certificates/generation/batchService.js";
import { missingMessageAr } from "../../src/services/certificates/generation/batchAnswer.js";
import { batchFacts, guardBatchSize, isBatchSize } from "../../src/services/certificates/experiment/experimentFill.js";

const { assert, counts } = makeAssert();

const F = [
  { key: "batch_size", label: "Batch size", required: true },
  { key: "batch_number", label: "Batch number", required: true, isBatchFact: true },
  { key: "spec_ph", label: "pH specification" },
  { key: "result_ph", label: "pH result", isLabResult: true, required: true },
  { key: "result_assay", label: "Assay result", isLabResult: true, required: true },
  { key: "result_appearance", label: "Appearance result", isLabResult: true },
];
const vals = (o) => Object.fromEntries(F.map((f) => [f.key, { value: o[f.key] ?? "" }]));

console.log("1 · rows taken off");
assert("COA: unknown results and batch size go; known ones and the batch number stay", JSON.stringify(rowsToRemove(F, vals({ result_assay: "99%", batch_number: "B1" }), "COA")) === JSON.stringify(["batch_size", "result_ph", "result_appearance"]));
assert("a stored value object or a bare string reads the same", rowsToRemove(F, { ...vals({}), result_ph: "5.2" }, "COA").includes("result_ph") === false);
assert("a COC / HC never loses a row", rowsToRemove(F, vals({}), "COC").length === 0 && rowsToRemove(F, vals({}), "HC").length === 0);
const stored = { result_ph: { value: "", flags: ["missing"] }, spec_ph: { value: "4.0-6.5", flags: [] }, result_assay: { value: "99%", flags: [] } };
applyRemovedRows(stored, { removed: { result_ph: ["result_ph", "spec_ph"] } });
assert("the removed value is flagged row_removed (never missing → never blocking)", stored.result_ph.flags.includes(ROW_REMOVED) && !stored.result_ph.flags.includes("missing"), stored.result_ph.flags);
assert("its specification went with it", stored.spec_ph.removedWith === "result_ph" && stored.spec_ph.flags.includes(ROW_REMOVED));
assert("removedKeys lists the test, not its specification", JSON.stringify(removedKeys(stored)) === JSON.stringify(["result_ph"]));
applyRemovedRows(stored, { removed: {} });
assert("re-rendered with a value: the specification's link is cleared", !("removedWith" in stored.spec_ph));

console.log("2 · never N/A");
assert("N/A, n/a, N.A., Not applicable, غير متاح read as N/A", ["N/A", "n/a", "N.A.", "Not applicable", "غير متاح"].every(isNA));
assert("Complies, NA-free text, empty are not", !isNA("Complies") && !isNA("Nana") && !isNA(""));
const oral = { name: "H-DURIN", physicalForm: "LIQUID", productType: "Supplement" };
const ster = { key: "result_sterility", label: "Sterility result", isLabResult: true, required: true, source: { kind: "static", value: "" } };
const r1 = resolveWithNeed(ster, { product: oral, typeCode: "COA" }, null);
assert("Sterility on an oral product: empty (never \"N/A\"), empty on purpose", r1.value === "" && r1.provenance?.rule === "not_applicable_oral" && emptyOnPurpose(r1), r1);
const naField = { key: "result_ph", label: "pH result", isLabResult: true, required: true, source: { kind: "static", value: "N/A" } };
const reg = { key: "reg_no", label: "Registration No.", required: true, source: { kind: "product", path: "registrationNumber" } };
const r2 = resolveWithNeed(reg, { product: { registrationNumber: "N/A" }, typeCode: "COC" }, null);
assert("an \"N/A\" from the product is dropped — a required place is then missing, never printed \"N/A\"", r2.value === "" && r2.provenance?.droppedNA === true && r2.flags.includes("missing"), r2);
const r3 = resolveWithNeed(naField, { product: {}, typeCode: "COA" }, { id: "n1", value: "N/A", status: "provided" });
assert("a person's own \"N/A\" stands", r3.value === "N/A");
const r4 = resolveWithNeed(naField, { product: {}, typeCode: "COA" }, { id: "n2", value: "N/A", status: "resolved_ai" });
assert("the AI's \"N/A\" doesn't", r4.value === "");

console.log("3 · the one line");
assert("rowName drops «result»", rowName({ label: "pH result" }) === "pH" && rowName({ label: "Assay Result" }) === "Assay");
assert("the card's line", removedLineAr(["pH", "Assay", "pH"]) === "اتشال من الشهادة: pH، Assay — مفيش نتيجة. ابعت النتيجة في سطر وترجع");
assert("nothing taken off → no line", removedLineAr([]) === null);
const msg = missingMessageAr([{ certificateId: "c", product: "ADDHEPA", code: "COA", items: [], removed: [{ name: "pH" }, { name: "Assay" }] }]);
assert("the drafts' message lists it per product, even with nothing blocking", msg === "• ADDHEPA (COA): اتشال من الشهادة: pH، Assay — مفيش نتيجة. ابعت النتيجة في سطر وترجع", msg);

console.log("4 · experiment batch size");
const f = batchFacts({ quantity: 2400, packing: "100 mL" });
assert("2400 × 100 mL → 240 L; the count is in units", f.total === "240 L" && f.quantity === "2400 units", f);
assert("\"2400 L\" for 2400 bottles → 240 L", guardBatchSize("2400 L", f) === "240 L");
assert("a plausible batch size the model gave stays", guardBatchSize("1200 L", f) === "1200 L");
assert("no pack: the count in units", guardBatchSize("2400 L", batchFacts({ quantity: "2,400" })) === "2400 units");
assert("«Batch Size» and «حجم التشغيلة» are batch sizes", isBatchSize({ label: "Batch Size" }) && isBatchSize({ label: "حجم التشغيلة" }) && !isBatchSize({ label: "Batch No." }));

console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
process.exit(counts.failed ? 1 : 0);
