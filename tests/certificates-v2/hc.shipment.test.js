// 28 Nov — ADDVET's HC as ONE certificate per shipment (pure, no stack needed):
//   1 its EXPORTER / CONSIGNEE block → the company record / the shipment's invoice, never the sample's
//     consignee ("MADHOOB TRADING GROUP"); an address over two lines is one value wrapped over them
//   2 its "ATTACHED LIST" page → one repeating row, each column from its own header phrase
//   3 a COA row kept as one line ("Assay <spec> <result>") → its specification and result, no
//     «Quantity / pack» blank inside the specification
//   4 the consignee answered once in a chat line, parsed by code; the ask is one line of its own
import { makeAssert } from "./helpers.js";
import { partyFields, isCountryLine, splitPartyBlock } from "../../src/services/certificates/templates/partyBlocks.js";
import { productTableFrom } from "../../src/services/certificates/templates/productTable.js";
import { fieldsForAreas } from "../../src/services/certificates/templates/autoMap.js";
import { resolveField, wrapPiece } from "../../src/services/certificates/generation/valueResolver.js";
import { validateSource } from "../../src/services/certificates/templates/sourceCatalogue.js";
import { parseConsigneeLine, missingMessageAr, fieldRole } from "../../src/services/certificates/generation/batchAnswer.js";
import { HC_PAGE1, HC_PAGE2, HC_PRODUCT_NAMES } from "../fixtures/addvetHcLines.js";
import { isPhysicalForm } from "../../src/services/harvest/productForm.js";

const { assert, counts } = makeAssert();
const by = (fields) => Object.fromEntries(fields.map((f) => [f.key, f]));

console.log("\n1 · party blocks");
const parties = by(partyFields(HC_PAGE1, { companyNames: ["AFAQ ADDITIVES FEED CO.", "ADDVET"] }));
assert("the exporter's name is the company's producer name", parties.exporter_name?.source?.path === "profile.producerName" && parties.exporter_name.sampleValue === "AFAQ ADDITIVES FEED CO.", parties.exporter_name);
assert("the consignee's name comes from the invoice and is required", parties.consignee_name?.source?.kind === "invoice" && parties.consignee_name.source.path === "customerName" && parties.consignee_name.required === true, parties.consignee_name);
assert("the line shared by both names is split after the company's name", parties.consignee_name?.sampleValue === "MADHOOB TRADING GROUP");
assert("every consignee line is a field (nothing of the sample's consignee stays printed)", ["p1-l6", "p1-l7", "p1-l8", "p1-l9"].every((id) => Object.values(parties).some((f) => f.lineId === id && f.source.kind === "invoice")), Object.values(parties).map((f) => f.lineId));
assert("the consignee's country, phone and address", parties.consignee_country?.source.path === "customerCountry" && parties.consignee_phone?.source.path === "customerPhone" && parties.consignee_address_1?.source.path === "customerAddress");
assert("the exporter's email (after «Email:») and phone (after «Tel:»)", parties.exporter_email?.sampleValue === "info@addvet.net" && parties.exporter_phone?.sampleValue === "009647561746315");
assert("an address over two lines is wrapped at the sample's widths", JSON.stringify(parties.exporter_address_2?.source.wrap) === JSON.stringify({ index: 1, widths: [40, 16] }), parties.exporter_address_2?.source);
assert("a wrap source is valid", validateSource(parties.exporter_address_1.source).length === 0, validateSource(parties.exporter_address_1.source));
assert("no party block on a page without one", partyFields(HC_PAGE2, { companyNames: ["ADDVET"] }).length === 0);
assert("a country line vs an address naming a country", isCountryLine("Sultante Of Oman") && isCountryLine("Pakistan") && !isCountryLine("Jordan-Amman -Ghardenz St. Yousef Center"));
const company = { name: "ADDVET", address: "Jordan-Amman -Ghardenz St. Yousef Center 2-Building No:12", profile: { producerName: "AFAQ ADDITIVES FEED CO." } };
assert(
  "the company address prints over the two lines as the sample did",
  resolveField(parties.exporter_address_1, { company }).value === "Jordan-Amman -Ghardenz St. Yousef Center" && resolveField(parties.exporter_address_2, { company }).value === "2-Building No:12",
);
assert("no invoice consignee → the consignee name is empty (flagged, asked), never the sample", resolveField(parties.consignee_name, { invoice: {} }).value === "");
const block = splitPartyBlock("Madhoob Trading Group Mawaleh South, Muscat. Sultante Of Oman P.O Box 437 Tel: +968268904412");
assert("a party printed as one cell is split into name, address, country, phone", block?.name === "Madhoob Trading Group" && block.address === "Mawaleh South, Muscat. P.O Box 437" && block.country === "Sultante Of Oman" && block.phone === "+968268904412", block);
assert("a block without a company-form word is never guessed apart", splitPartyBlock("Some Person Street 5") === null);
assert("a short address leaves the second line empty", wrapPiece("Muscat", { index: 1, widths: [22, 11] }) === "");

console.log("\n2 · the attached list");
const table = productTableFrom([...HC_PAGE1, ...HC_PAGE2], HC_PRODUCT_NAMES);
// SULFARIM isn't one of the company's products: its row is still one of the 10 sample rows
const known = productTableFrom([...HC_PAGE1, ...HC_PAGE2], HC_PRODUCT_NAMES.filter((n) => n !== "SULFARIM"));
assert("an unrecognised product's row still counts as a sample row (10, not 9)", known.rows === 10 && known.group?.sampleRows === 10, known.rows);
const cells = by(table.fields || []);
assert("10 sample rows → one repeating row over the invoice lines", table.rows === 10 && table.group?.source?.kind === "invoice_lines", table.problem || table.rows);
assert("each column from its own header phrase", cells.row_product_name?.source.path === "product.name" && cells.row_cell_2?.source.path === "product.brand.name" && cells.row_cell_4?.source.path === "product.packaging" && cells.row_cell_5?.source.path === "product.physicalForm", Object.values(cells).map((c) => `${c.key}:${c.source.path}`));
assert("a one-word description column is the category", cells.row_cell_3?.source.path === "product.productType", cells.row_cell_3?.source);
assert("centred columns stay centred (the sample cells' centres line up)", cells.row_cell_3?.align === "center" && cells.row_cell_4?.align === "center" && cells.row_product_name?.align === "left", Object.values(cells).map((c) => `${c.key}:${c.align}`));
const p2 = by(
  fieldsForAreas(
    [{ lineId: "n", page: 2, kind: "batch", label: "Batch number", text: "PL231562", charStart: 0, charEnd: 8 }],
    [
      { id: "l", page: 2, text: "CERTIFICATE NO:  ", box: { x: 48, y: 177, w: 109, h: 12 } },
      { id: "n", page: 2, text: "PL231562", box: { x: 192, y: 177, w: 58, h: 12 } },
    ],
  ),
);
assert("a value right of «CERTIFICATE NO:» is the document number, not a batch number", p2.document_number?.source?.kind === "docnumber" && !p2.batch_number, Object.keys(p2));

console.log("\n2b · physical form vs a document's «Product Form»");
assert("Liquid / Injectable solution / Water soluble powder are forms; Antibiotic / Supplement / Injectable aren't", ["LIQUID", "Injectable solution", "Water soluble powder", "Tablet"].every(isPhysicalForm) && !["Antibiotic", "Supplement", "Injectable", "Injection"].some(isPhysicalForm));
const formLines = [
  { id: "f1", page: 1, text: "Product Form:  Antibiotic", box: { x: 74, y: 300, w: 200, h: 12 } },
  { id: "f2", page: 1, text: "Form:  Liquid", box: { x: 74, y: 320, w: 120, h: 12 } },
];
const forms = by(
  fieldsForAreas(
    [
      { lineId: "f1", page: 1, kind: "value", label: "Product form", text: "Antibiotic", charStart: 15, charEnd: 25 },
      { lineId: "f2", page: 1, kind: "value", label: "Form", text: "Liquid", charStart: 7, charEnd: 13 },
    ],
    formLines,
  ),
);
assert("a «Product Form» place prints the certificate's label (productForm); a «Form» place the physical form", forms.product_form?.source?.path === "productForm" && forms.form?.source?.path === "physicalForm", Object.values(forms).map((f) => `${f.key}:${f.source?.path}`));

// ADDVET's COC (prod lines): "Product Form:" stacked over "Supplement", the place read as a plain "Form"
const cocLines = [
  { id: "p1-l36", page: 1, text: "36 months from the production date.", box: { x: 68, y: 740, w: 205, h: 12.667 } },
  { id: "p1-l37", page: 1, text: "Product Form:", box: { x: 68, y: 776, w: 82, h: 12.667 } },
  { id: "p1-l38", page: 1, text: "Supplement", box: { x: 68, y: 792, w: 67, h: 12.667 } },
  { id: "p1-l39", page: 1, text: "Category:", box: { x: 68, y: 828, w: 55, h: 12.667 } },
];
const stacked = fieldsForAreas([{ lineId: "p1-l38", page: 1, kind: "value", label: "Form", text: "Supplement", charStart: 0, charEnd: 10 }], cocLines);
assert("a «Product Form:» label stacked above the place → the certificate's label (productForm), not the physical form", stacked[0]?.source?.path === "productForm", stacked.map((f) => `${f.label}:${f.source?.path}`));
const notStacked = fieldsForAreas([{ lineId: "p1-l36", page: 1, kind: "value", label: "Validity", text: "36 months from the production date.", charStart: 0, charEnd: 35 }], cocLines);
assert("a line above that isn't a label (no ending «:») is never taken for one", notStacked[0]?.source?.path === "validity", notStacked.map((f) => `${f.label}:${f.source?.path}`));

console.log("\n3 · a COA row on one line");
const t = "Assay 90-110% of the labeled amount of constituents 101.7%";
const coa = by(
  fieldsForAreas(
    [
      { lineId: "a", page: 1, kind: "quantity", label: "Quantity / pack", text: "110%", charStart: t.indexOf("110%"), charEnd: t.indexOf("110%") + 4 },
      { lineId: "a", page: 1, kind: "quantity", label: "Quantity / pack", text: "101.7%", charStart: t.length - 6, charEnd: t.length },
    ],
    [{ id: "a", page: 1, text: t, box: { x: 74, y: 865, w: 450, h: 12 } }],
  ),
);
assert("its specification from the product", coa.spec_assay?.sampleValue === "90-110% of the labeled amount of constituents" && coa.spec_assay.source.path === "specifications.values.Assay", coa);
assert("its result a lab result", coa.result_assay?.sampleValue === "101.7%" && coa.result_assay.isLabResult === true);
assert("no «Quantity / pack» blank", !Object.values(coa).some((f) => f.label === "Quantity / pack"));

console.log("\n4 · the consignee, once");
const c = parseConsigneeLine("المستلم: MADHOOB TRADING GROUP — Mawaleh South, Muscat, P.O Box 437 — Sultanate of Oman — +968 2689 0441");
assert("name, address, country, phone parsed from the line", c?.customerName === "MADHOOB TRADING GROUP" && c.customerAddress === "Mawaleh South, Muscat, P.O Box 437" && c.customerCountry === "Sultanate of Oman" && c.customerPhone === "+968 2689 0441", c);
assert("a line that isn't a consignee → null", parseConsigneeLine("ADDHEPA باتش MADADD2610001") === null);
assert("a consignee field's role", fieldRole({ source: { kind: "invoice", path: "customerName" } }).role === "consignee");
const msg = missingMessageAr([
  { product: "—", code: "HC", items: [{ role: "consignee", label: "Consignee name" }] },
  { product: "ADDHEPA", code: "COA", items: [{ role: "batchNo", label: "Batch number" }] },
]);
assert("the ask is one line of its own, after the batch data", /المستلم \(Consignee\) في HC/.test(msg) && /ADDHEPA \(COA\)/.test(msg) && !/• — \(HC\)/.test(msg), msg);
assert("only the consignee missing → only the ask", /^المستلم/.test(missingMessageAr([{ product: "—", code: "HC", items: [{ role: "consignee", label: "Consignee name" }] }])));

console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
process.exit(counts.failed ? 1 : 0);
