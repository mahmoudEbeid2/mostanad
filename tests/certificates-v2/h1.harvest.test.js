// 28 Nov add-on, "read every file": the person never types what a file already says.
//   harvest  — a page's labelled values (name, pack, validity, form, category, origin, producer,
//              composition, the document's numbering) with their source; a COC's own document
//              number and date are never kept as values, only their pattern
//   merge    — the higher-priority source fills; two sources that disagree are shown once with
//              both, and nothing already filled is overwritten
//   filling  — an automatic template's places get their source by what they are (product data,
//              composition rows, specifications, document number, issue date, batch facts);
//              lab results and batch facts stay the person's to give
//   numbers  — a certificate's number continues the company's own numbering, never repeats
// Unit + DB parts (no API needed).
import fs from "fs";
import path from "path";
import { makeAssert, createCompany, cleanupCompany, prisma, finish } from "./helpers.js";
import { harvestPage, numberPattern } from "../../src/services/harvest/harvestRules.js";
import { mergeProduct } from "../../src/services/harvest/harvestService.js";
import { findVariableAreas } from "../../src/services/certificates/templates/readinessCheck.js";
import { fieldsForAreas } from "../../src/services/certificates/templates/autoMap.js";
import { amountParts } from "../../src/services/certificates/generation/valueResolver.js";
import { formatNumber, allocateDocNumber } from "../../src/services/certificates/generation/docNumbers.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const fx = (n) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", n), "utf8"));

console.log("Harvest — a real ADDVET COC page");
const coc = fx("addvet-coc-pages.json");
const facts = harvestPage({ text: coc[0].text, kind: "certificate", certCode: "COC" });
const by = Object.fromEntries(facts.map((f) => [`${f.entity}:${f.key}`, f.value]));
assert("  reads name, pack, validity, form, category", by["product:name"] === "ADDMECTIN 1%" && by["product:packaging"] === "100 mL" && /36 months/.test(by["product:validity"]) && by["product:physicalForm"] === "Liquid" && by["product:category"] === "Injectable", by);
assert("  reads the composition and its basis", by["product:activeIngredients"]?.[0]?.name === "Ivermectin" && by["product:compositionBasis"] === "Each 1 mL contains", by);
assert("  reads the producer", by["company:producerName"] === "AFAQ ADDITIVES FEED CO.", by);
assert("  every fact carries its quote", facts.every((f) => f.snippet), facts.filter((f) => !f.snippet));
assert("  the document's own number and date are not kept as values — only the numbering pattern", !facts.some((f) => /documentNo|issueDate/.test(f.key)) && by["document:numbering"]?.pattern, facts.map((f) => f.key));
assert("  a COC page gives no batch facts", !facts.some((f) => f.perBatch), facts.filter((f) => f.perBatch));
assert("numbering pattern: COAAVVI0926010 issued 09/2026 → COAAVVI{MM}{YY}{SEQ3}", numberPattern("COAAVVI0926010", "23/9/2026")?.pattern === "COAAVVI{MM}{YY}{SEQ3}", numberPattern("COAAVVI0926010", "23/9/2026"));
assert("formatNumber continues it", formatNumber("COAAVVI{MM}{YY}{SEQ3}", 11, new Date(2026, 10, 28)) === "COAAVVI1126011");

console.log("Filling — the ADDVET COA's open places");
const coa = fx("addvet-coa-version.json");
const { areas } = findVariableAreas(coa.lines, coa.fields);
const fields = fieldsForAreas(areas, coa.lines, { certCode: "COA", dateFormat: "D/M/YYYY" });
const of = (sample) => fields.find((f) => f.sampleValue === sample);
const src = (sample) => JSON.stringify(of(sample)?.source);
assert("  production date → the request line, as month/year (label read from its row)", src("11/2022") === JSON.stringify({ kind: "item", path: "productionDate" }) && of("11/2022").isBatchFact && of("11/2022").format?.date === "MM/YYYY", fields.filter((f) => /\/20/.test(f.sampleValue)));
assert("  batch size → typed (a batch fact, never filled)", of("564 KG")?.source.kind === "manual" && of("564 KG").isBatchFact);
assert("  the old certificate's issue date → today, never its own date", src("05/02/2023") === JSON.stringify({ kind: "today" }));
assert("  lab results stay blank (manual, a lab result)", ["Conforms", "Positive", "102.7%"].every((s) => fields.some((f) => f.sampleValue === s && f.source.kind === "manual" && f.isLabResult)), fields.filter((f) => f.isLabResult));
assert("  specifications → the product's specifications (a range stays whole: «3.0-5.0» is no result)", fields.some((f) => f.source.path === "specifications.values.pH" && f.sampleValue === "3.0-5.0"), fields.filter((f) => /^spec_/.test(f.key)));
assert("  category, packing → the product", src("SUPPLEMENT") === JSON.stringify({ kind: "product", path: "productType" }) && src("1L") === JSON.stringify({ kind: "product", path: "packaging" }));
assert("  document number → the company's numbering; issue date → today in its format", fields.some((f) => f.source.kind === "docnumber") && fields.some((f) => f.source.kind === "today" && f.format?.date === "DD/MM/YYYY"));
const comp = fields.filter((f) => /^comp_/.test(f.key));
assert("  composition: row 1 = ingredient 1, its amount and unit as two fields", comp.some((f) => f.source.path === "activeIngredients[0].name" && f.sampleValue === "Vitamin E") && comp.some((f) => f.source.path === "activeIngredients[0].amountFigure" && f.sampleValue === "120000") && comp.some((f) => f.source.path === "activeIngredients[0].amountUnit" && f.sampleValue === "mg"), comp.slice(0, 6));
assert("  only ingredient 1 is required (a shorter product leaves later rows empty)", comp.filter((f) => f.required).every((f) => /\[0\]/.test(f.source.path)));
assert("  no place prints its sample: every field has a source", fields.every((f) => f.source?.kind));
assert("amountParts: «15,000 IU», «ad 1 mL», «5 mg/kg»", JSON.stringify([amountParts("15,000 IU"), amountParts("ad 1 mL"), amountParts("5 mg/kg")]) === JSON.stringify([{ amountFigure: "15,000", amountUnit: "IU" }, { amountFigure: "ad 1", amountUnit: "mL" }, { amountFigure: "5", amountUnit: "mg/kg" }]));

console.log("Merge + numbering (DB)");
const co = await createCompany("h1");
try {
  const p = await prisma.product.create({ data: { companyId: co.id, name: "ADDMECTIN 1%", validity: null } });
  const fact = (o) => ({ companyId: co.id, entity: "product", productId: p.id, productName: p.name, page: 1, snippet: "q", ...o });
  await prisma.harvestedFact.createMany({
    data: [
      fact({ key: "validity", value: "36 months", valueNorm: "36months", sourceType: "certificate", fileId: "f-coc", fileName: "ADDVET COC.pdf", page: 10 }),
      fact({ key: "validity", value: "24 months", valueNorm: "24months", sourceType: "label", fileId: "f-label", fileName: "ADDMECTIN label.pdf" }),
      fact({ key: "physicalForm", value: "Liquid", valueNorm: "liquid", sourceType: "label", fileId: "f-label", fileName: "ADDMECTIN label.pdf" }),
    ],
  });
  let r = await mergeProduct(p.id);
  let row = await prisma.product.findUnique({ where: { id: p.id } });
  assert("  the certificate's validity fills (it outranks the label)", row.validity === "36 months" && row.fieldProvenance?.validity?.file === "ADDVET COC.pdf", row.fieldProvenance?.validity);
  const c = (row.harvestConflicts || []).find((x) => x.key === "validity");
  assert("  the label's different validity is a conflict, shown once with both sources", c && c.values.length === 2 && c.values.some((v) => v.file === "ADDMECTIN label.pdf" && v.value === "24 months") && c.values.some((v) => v.file === "ADDVET COC.pdf"), row.harvestConflicts);
  assert("  the form fills from the label", row.physicalForm === "Liquid");
  await prisma.product.update({ where: { id: p.id }, data: { physicalForm: "Suspension", fieldProvenance: { ...row.fieldProvenance, physicalForm: { source: "user" } } } });
  r = await mergeProduct(p.id);
  row = await prisma.product.findUnique({ where: { id: p.id } });
  assert("  a person's value is never overwritten by a file (re-merge)", row.physicalForm === "Suspension" && (row.harvestConflicts || []).filter((x) => x.key === "validity").length === 1, row);

  const a = await Promise.all([1, 2, 3, 4].map(() => allocateDocNumber(co.id, "COA", new Date(2026, 10, 28))));
  assert("  4 numbers at once → 4 different, in sequence (no pattern known: COA-2026-0001…)", new Set(a).size === 4 && a.sort()[0] === "COA-2026-0001", a);
  await prisma.company.update({ where: { id: co.id }, data: { profile: { numbering: { COA: { pattern: "COAAVVI{MM}{YY}{SEQ3}", lastSeq: 10 } } } } });
  assert("  a learnt numbering continues from its last number", (await allocateDocNumber(co.id, "COA", new Date(2026, 10, 28))) === "COAAVVI1126011");
} finally {
  await finish(counts, async () => {
    await prisma.harvestedFact.deleteMany({ where: { companyId: co.id } });
    await cleanupCompany(co.id);
  });
}
