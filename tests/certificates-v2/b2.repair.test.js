// Fill-automatically item 2 (owner, 2026-10-24): "Fix this template".
// On the ADDVET golden, marked the way the production template was (the
// constituent rows as six separate fields, an unnamed “Field 6”, everything
// else fixed text), proven here:
//  - the scan: the analysis table, the constituent block, fixed specification
//    cells, fixed results, "Label: value" text, what Field 6 is
//  - suggested sources: Batch No. → the invoice line, the document number →
//    "COA" + the batch number, dates with their printed format, specs → product
//  - fixed results are never changed unless the owner picked what to do per row
//  - applying: a NEW version (vector background for the group), the ticked
//    changes, prepare re-run → ready with the gate; the base version untouched
//  - the repeating group is bound to the product's activeIngredients: a preview
//    prints that product's list (name ← ingredient, amount ← concentration)
//  - tenancy: another company → 404
// Needs the guarded stack (npm run dev:test) with pdf2htmlex.
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma, uploadTemplate, pollTask } from "./helpers.js";
import { scanTemplate, findHeader, labelValuePairs } from "../../src/services/certificates/templates/repairScan.js";
import { buildRepair, relocate } from "../../src/services/certificates/templates/repairService.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b2a");
const coB = await createCompany("b2b");
const A = asCompany(co.id);
const B = asCompany(coB.id);

// the production template's fields (ADDVET COA v1), by line and printed sample
const PROD_FIELDS = [
  ["product_name", "Product Name", "p1-l14", "ADD-E120", { kind: "product", path: "name" }, "product_data"],
  ["packing_size", "Packing Size", "p1-l16", "1L", { kind: "item", path: "packing" }, "invoice_line"],
  ["ph", "pH", "p1-l21", "3.0-5.0", { kind: "product", path: "specifications.values.Ph" }, "product_data"],
  ["ph_result", "pH result", "p1-l21", "4.0", { kind: "manual" }, "batch_data"],
  ["constituents_per_litre", "Constituents (per Litre)", "p1-l22", "Vitamin E", { kind: "manual" }, null],
  ["field_6", "Field 6", "p1-l23", "Sodium selenite", { kind: "manual" }, "unknown"],
  ["field_7", "Field 7", "p1-l24", "Distillate water up to", { kind: "static", text: "Distillate water up to" }, "constant"],
  ["constituents_per_litre_result", "Constituents (per Litre) result", "p1-l25", "120000 mg", { kind: "manual" }, null],
  ["sodium_selenite_result", "Sodium selenite result", "p1-l26", "60 mg", { kind: "manual" }, null],
  ["distillate_water_up_to_result", "Distillate water up to result", "p1-l27", "1000 mL", { kind: "manual" }, null],
];

try {
  console.log("\n🧪 The scan rules (pure)");
  const cell = (text, start, x0, x1) => ({ text, start, end: start + text.length, x0, x1, font: "f" });
  const cellLines = [
    { id: "h", page: 1, y: 100, h: 12, cells: [cell("Test", 0, 70, 100), cell("Specification", 5, 240, 320), cell("Result", 19, 530, 570)] },
    { id: "r1", page: 1, y: 120, h: 12, cells: [cell("Moisture", 0, 70, 120), cell("≤ 10%", 9, 240, 270), cell("Complies", 15, 530, 580)] },
    { id: "r2", page: 1, y: 140, h: 12, cells: [cell("Composition", 0, 70, 140), cell("Lysine", 12, 240, 280), cell("98 %", 19, 530, 560)] },
    { id: "r3", page: 1, y: 156, h: 12, cells: [cell("Methionine", 0, 240, 300)] },
    { id: "r3b", page: 1, y: 156, h: 12, cells: [cell("1.5 g", 0, 530, 560)] },
    { id: "para", page: 1, y: 190, h: 12, cells: [cell("We certify that this product complies with the specification above.", 0, 70, 600)] },
  ];
  const lines = cellLines.map((l) => ({ id: l.id, page: 1, text: l.cells.map((c) => c.text).join(" ") }));
  const header = findHeader(cellLines);
  assert("header: label / spec / result columns from the printed headings", header?.columns.map((c) => c.kind).join() === "label,spec,result");
  const scan = scanTemplate({ lines, cellLines, fields: [], groups: [] });
  const group = scan.items.find((i) => i.kind === "constituent_group");
  assert("a “Composition” row + the unlabelled row under it → ONE group over activeIngredients", group?.group.source.path === "activeIngredients" && group.group.sampleRows === 2 && group.cells.map((c) => c.source.path).join() === "name,concentration", group);
  assert("the paragraph ends the table (it crosses the columns)", scan.rows.length === 3);
  assert("a fixed spec cell → a field candidate; its fixed result → the owner's decision, never pre-decided", scan.items.some((i) => i.kind === "fixed_to_field" && i.field.sampleValue === "≤ 10%") && scan.items.some((i) => i.kind === "fixed_result" && i.text === "Complies" && i.default === null && i.choices.includes("show_specification")));
  assert("Label: value pairs, offsets into the line", JSON.stringify(labelValuePairs({ id: "x", text: "Batch No.:  AB12  •  Issue Date: 05/02/2023" }).map((p) => [p.label, p.value.text, p.value.start])) === JSON.stringify([["Batch No.", "AB12", 12], ["Issue Date", "05/02/2023", 33]]));
  {
    const plan = { items: scan.items };
    let b = buildRepair(plan, [], [], []);
    assert("nothing ticked → nothing applied, results stay fixed", b.applied.length === 0 && b.fields.length === 0);
    const res = scan.items.find((i) => i.kind === "fixed_result");
    b = buildRepair(plan, [], [], [{ id: res.id, choice: "show_specification" }]);
    const shown = b.fields.find((f) => f.showSpecInstead);
    assert("“show the specification” adds the result field AND its specification field, even unticked", shown && b.fields.some((f) => f.key === shown.specFieldKey && f.sampleValue === "≤ 10%") && shown.isLabResult);
    b = buildRepair(plan, [], [], [{ id: res.id, choice: "lab_result_field" }]);
    assert("“lab-result field” → a manual, flagged field over the result cell", b.fields.length === 1 && b.fields[0].isLabResult && b.fields[0].source.kind === "manual" && b.fields[0].sampleValue === "Complies");
    b = buildRepair(plan, [], [], [{ id: "field:nope:1", apply: true }]);
    assert("an id that isn't in the checklist → a problem, nothing guessed", b.problems.length === 1);
  }
  assert("relocate: same offsets kept; a moved sample found once on its line", (() => {
    const f = { lineId: "a", charStart: 0, charEnd: 3, sampleValue: "4.0" };
    return relocate(f, [{ id: "a", text: "4.0 x" }]).charStart === 0 && relocate(f, [{ id: "a", text: "pH 4.0" }]).charStart === 3 && relocate(f, [{ id: "b", text: "x 4.0" }]).lineId === "b";
  })());

  console.log("\n🧪 The ADDVET golden, marked like the production template");
  let r = await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" });
  const typeId = r.data.data.type.id;
  const up = await uploadTemplate(co.id, { file: "ADDVET_COA.ai", certificateTypeId: typeId, name: "ADDVET COA" });
  const base = up.version;
  assert("converted to draft (raster background)", base?.status === "draft" && base.backgroundFormat === "png", base?.status);
  const at = (lineId, v, last) => {
    const t = base.lines.find((l) => l.id === lineId).text;
    const s = last ? t.lastIndexOf(v) : t.indexOf(v);
    return { charStart: s, charEnd: s + v.length };
  };
  const fields = PROD_FIELDS.map(([key, label, lineId, sampleValue, source, dataCategory], i) => ({ key, label, lineId, sampleValue, source, dataCategory, align: "left", sortOrder: i, ...at(lineId, sampleValue, key === "ph_result") }));
  r = await api("PUT", `/template-versions/${base.id}/fields`, A, { fields });
  assert("the production field set saves", r.status === 200, r.data);
  assert("…the result-labelled fields are pre-set as lab results", r.data.data.fields.filter((f) => f.isLabResult).map((f) => f.key).sort().join() === "constituents_per_litre_result,distillate_water_up_to_result,ph_result,sodium_selenite_result");

  r = await api("GET", `/template-versions/${base.id}/repair`, A);
  assert("GET …/repair → 200", r.status === 200, r.data);
  const plan = r.data.data.plan;
  const item = (id) => plan.items.find((i) => i.id === id);
  const byLabel = (label) => plan.items.find((i) => i.kind === "fixed_to_field" && i.label === label);
  const grp = plan.items.find((i) => i.kind === "constituent_group");
  assert("the table: Analysis / Specifications / Results", plan.table?.columns.map((c) => c.kind).join() === "label,spec,result");
  assert("ONE constituent group over the product's activeIngredients, 3 sample rows", grp?.group.source.kind === "product_list" && grp.group.source.path === "activeIngredients" && grp.group.sampleRows === 3);
  assert("…name ← ingredient (p1-l22 “Vitamin E”), amount ← concentration (p1-l25 “120000 mg”)", grp.cells[0].lineId === "p1-l22" && grp.cells[0].sampleValue === "Vitamin E" && grp.cells[0].source.path === "name" && grp.cells[1].lineId === "p1-l25" && grp.cells[1].sampleValue === "120000 mg" && grp.cells[1].source.path === "concentration");
  assert("…replacing the six fields that hard-coded ADD-E120's list", [...grp.removes].sort().join() === "constituents_per_litre,constituents_per_litre_result,distillate_water_up_to_result,field_6,field_7,sodium_selenite_result", grp.removes);
  assert("Field 6 identified: the second constituent's name, absorbed by the group", item("unnamed:field_6")?.absorbedBy === grp.id && /constituent/.test(item("unnamed:field_6").identifiedAs));
  assert("needs the vector background (a group)", plan.needsSvg === true);
  const sug = (label) => byLabel(label)?.suggestion;
  assert("Batch No. → the invoice line's batch", JSON.stringify(sug("Batch No.")?.source) === JSON.stringify({ kind: "item", path: "batchNo" }));
  assert("Document # “COAAVVS1122005” → “COA” + the batch number", sug("Document #")?.source?.template === "COA{{item.batchNo}}");
  assert("Production / Expiry Date → the line, format MM/YYYY from the print", sug("Production Date")?.source.path === "productionDate" && sug("Production Date").format?.date === "MM/YYYY" && sug("Expiry Date")?.source.path === "expiryDate");
  assert("Issue Date → today; 05/02/2023 is ambiguous, so the day/month order is asked, not guessed", sug("Issue Date")?.source.kind === "today" && sug("Issue Date").ambiguousDate?.length === 2 && !sug("Issue Date").format?.date);
  assert("Batch Size → per batch (a lab-result-like fact: never inferred)", sug("Batch Size")?.source.kind === "manual" && sug("Batch Size").isLabResult === true);
  assert("Category / Origin → the product, upper case as printed", sug("Category")?.source.path === "category.name" && sug("Category").format?.case === "upper" && sug("Origin")?.source.path === "origin");
  assert("specifications: Appearance → product.appearance; Sterility → its specification key", sug("Appearance")?.source.path === "appearance" && sug("Sterility")?.source.path === "specifications.values.Sterility" && sug("Identification")?.source.path === "specifications.values.Identification");
  assert("the Identification spec is one cell despite kerning (“Positive to HPLC test”)", byLabel("Identification")?.field.sampleValue === "Positive to HPLC test");
  const results = plan.items.filter((i) => i.kind === "fixed_result");
  assert("fixed results listed per row, none decided: Appearance, Identification, Sterility, Pyrogen, Assay (102.7%)", results.map((i) => i.rowLabel).join() === "Appearance,Identification,Sterility,Pyrogen,Assay" && results.every((i) => i.default === null) && results.find((i) => i.rowLabel === "Assay").text === "102.7%");
  assert("the Producer row's “—” is not a result to decide", !results.some((i) => i.rowLabel === "Producer"));

  r = await api("GET", `/template-versions/${base.id}/repair`, B);
  assert("another company → 404", r.status === 404, r.status);
  r = await api("POST", `/template-versions/${base.id}/repair`, B, { decisions: [{ id: grp.id, apply: true }] });
  assert("…POST too", r.status === 404, r.status);
  r = await api("POST", `/template-versions/${base.id}/repair`, A, { decisions: [{ id: results[0].id, choice: "made_up" }] });
  assert("an unknown result choice → 400", r.status === 400, r.status);
  r = await api("POST", `/template-versions/${base.id}/repair`, A, { decisions: [] });
  assert("nothing ticked → 422 NOTHING_TO_REPAIR", r.status === 422 && r.data.code === "NOTHING_TO_REPAIR", r.data);

  // the owner ticks everything and decides each result row
  const CHOICE = { Appearance: "show_specification", Identification: "keep_fixed", Sterility: "show_specification", Pyrogen: "keep_fixed", Assay: "lab_result_field" };
  const decisions = plan.items.map((i) => (i.kind === "fixed_result" ? { id: i.id, choice: CHOICE[i.rowLabel] } : { id: i.id, apply: true }));
  r = await api("POST", `/template-versions/${base.id}/repair`, A, { decisions });
  assert("POST …/repair → 202, a new version number, re-converted", r.status === 202 && r.data.data.versionNumber === 2 && r.data.data.reconverted === true, r.data);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 240_000 });
  assert("the repair job: convert → apply → prepare → ready", task.status === "completed" && task.result?.status === "ready" && task.result.passed === true, task.error || task.result);
  const v2 = (await api("GET", `/template-versions/${r.data.data.versionId}`, A)).data.data.version;
  const f2 = new Map(v2.fields.map((f) => [f.key, f]));
  assert("v2: vector background, ready, the gate passed incl. the group", v2.status === "ready" && v2.backgroundFormat === "svg" && v2.prepareReport?.passed === true && v2.prepareReport.checks.some((c) => c.id === "groups" && c.passed), v2.prepareReport?.checks);
  assert("v2: the group and its two cells; the six constituent fields gone", v2.groups?.length === 1 && v2.groups[0].source.path === "activeIngredients" && f2.get("ingredient")?.groupKey && f2.get("amount")?.groupKey && !["field_6", "field_7", "constituents_per_litre", "sodium_selenite_result"].some((k) => f2.has(k)));
  assert("v2: batch, dates, document, category, origin and the specifications are fields now", ["batch_no", "production_date", "expiry_date", "document", "issue_date", "category", "origin", "appearance", "sterility", "identification", "pyrogen", "assay", "producer"].every((k) => f2.has(k)), [...f2.keys()]);
  assert("v2: Appearance/Sterility results show their specification; Assay is a lab-result field; Identification/Pyrogen stay fixed", f2.get("appearance_result")?.showSpecInstead && f2.get("appearance_result").specFieldKey === "appearance" && JSON.stringify(f2.get("appearance_result").source) === JSON.stringify(f2.get("appearance").source) && f2.get("sterility_result")?.showSpecInstead && f2.get("assay_result")?.isLabResult && !f2.get("assay_result").showSpecInstead && !f2.has("identification_result") && !f2.has("pyrogen_result"));
  const rec = (await prisma.templateVersion.findUnique({ where: { id: v2.id }, select: { conversion: true, basedOnVersionId: true } }));
  assert("v2 records what was applied and on which version", rec.basedOnVersionId === base.id && rec.conversion?.repair?.basedOn === base.id && rec.conversion.repair.applied.length === decisions.filter((d) => d.apply || (d.choice && d.choice !== "keep_fixed")).length - 2, rec.conversion?.repair);
  const baseNow = (await api("GET", `/template-versions/${base.id}`, A)).data.data.version;
  assert("the base version is untouched (same 10 fields, still a draft)", baseNow.status === "draft" && baseNow.fields.length === 10);

  console.log("\n🧪 The group is bound to the product's own list");
  const p = await prisma.product.create({ data: { companyId: co.id, name: "VITA B+", appearance: "Clear red liquid", activeIngredients: [{ name: "Vitamin B1", concentration: "10 mg/ml" }, { name: "Vitamin B12", concentration: "20 mcg/ml" }, { name: "Biotin", concentration: "100 mcg/ml" }, { name: "Choline chloride", concentration: "10 mg/ml" }] } });
  r = await api("POST", `/template-versions/${v2.id}/preview`, A, { productId: p.id });
  const rows = r.data?.data?.values?.constituents?.rows || [];
  assert("preview: 4 rows = VITA B+'s ingredients, in order (not ADD-E120's 3)", rows.length === 4 && rows.map((x) => `${x.ingredient}=${x.amount}`).join("|") === "Vitamin B1=10 mg/ml|Vitamin B12=20 mcg/ml|Biotin=100 mcg/ml|Choline chloride=10 mg/ml", rows);
  assert("…rendered, and ADD-E120's “Sodium selenite” row is gone", r.data.data.html.includes("Vitamin B12") && !r.data.data.html.includes("Sodium selenite"));
  assert("…the appearance result prints the product's appearance (the specification)", r.data.data.values.appearance_result?.value === "Clear red liquid" && r.data.data.values.appearance?.value === "Clear red liquid", r.data.data.values.appearance_result);
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
