// The client's normal path, unblocked (client report 25 Nov: "it stopped at regulatory",
// "MAXVET wouldn't accept files", products one by one):
//   rules       — one country in every spelling ("SA" label, "Saudi Arabia" rules); where a
//                 country's rules stand (in force / waiting for approval / stuck); another
//                 country's rules copied as a starting point, NOT in force until approved;
//                 the label check runs with them once approved;
//   references  — a duplicate is the same FILE for the same owner: the same file twice in
//                 one upload once, a corrected file with the same name queued, the same file
//                 for another company queued; MAXVET's own labels (when on this machine) all queued;
//   products    — many at once from label files, a spreadsheet and a pasted list: one table
//                 (name, pack, form, category, composition basis, ingredients) from the files
//                 only (nothing inferred), corrected cells recorded as the person's, "save all"
//                 creates the products and lists what it left and why; tenant isolation.
// Needs `npm run dev:test`. MAXVET files: MAXVET_FILES or D:/turk/dass/client-files/MAXVET (skipped when absent).
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asCompany, createCompany, cleanupCompany, form, pollTask } from "./certificates-v2/helpers.js";
import { SAMPLE_LABEL_DATA } from "./fixtures/labelLayoutSample.js";
import { countryVariants } from "../src/services/assistant/countries.js";
import { runExtractJob } from "../src/services/catalogues/extraction/extractionService.js";
import { validate } from "../src/services/label/validation/validationEngine.js";
import { getApprovedRulesForCountry } from "../src/services/label/regulatory/regulatoryDocumentService.js";

/** The label check as the service runs it (its country's rules, any spelling), without the AI layer (GEMINI_DISABLED). */
const check = async (label) => validate(label.labelData, { rules: await getApprovedRulesForCountry(label.country, { companyId: label.companyId }), includePlausibility: false });

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const MAXVET = process.env.MAXVET_FILES || "D:/turk/dass/client-files/MAXVET";

/** A one-page label PDF with these lines (one product per file). */
async function labelPdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 420]);
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 390 - i * 18, size: i === 0 ? 18 : 9, font }));
  return Buffer.from(await doc.save());
}

/** The catalogue model, stubbed: it copies what each block prints (name = first line), with quotes. */
const labelModel = async (args) => {
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return {
    products: payload.blocks.map(({ blockId, text }) => {
      const lines = text.split("\n");
      const vq = (v) => (v ? { value: v, quote: v } : null);
      const after = (label) => lines.find((l) => l.startsWith(label))?.slice(label.length).trim() || null;
      const ingredients = lines.filter((l) => /\t/.test(l)).map((l) => {
        const [name, amountRaw] = l.split("\t");
        return { name: { value: name, quote: l }, amountRaw: { value: amountRaw, quote: l } };
      });
      return {
        blockId,
        isProduct: true,
        name: vq(lines[0]),
        packaging: vq(after("Packing:")),
        physicalForm: vq(after("Form:")),
        compositionBasis: vq(lines.find((l) => /contains/i.test(l)) || null),
        activeIngredients: ingredients.map((x) => ({ name: x.name.value, amountRaw: x.amountRaw.value, quote: x.name.quote })),
      };
    }),
  };
};

async function main() {
  console.log("🧪 Path 1 — rules, references, products in bulk\n");
  const coA = await createCompany(`p1A${s}`);
  const coB = await createCompany(`p1B${s}`);
  const A = asCompany(coA.id);
  const B = asCompany(coB.id);
  const docs = [];
  try {
    console.log("Rules for a country");
    assert("one country, every spelling: Saudi Arabia ↔ SA ↔ السعودية", ["SA", "Saudi Arabia", "السعودية"].every((x) => countryVariants("Saudi Arabia").includes(x)) && countryVariants("sa").includes("Saudi Arabia"));
    const sa = await prisma.regulatoryDocument.create({ data: { title: `SFDA test ${s}`, country: "Saudi Arabia", status: "approved", companyId: coA.id, extractedText: "The product name shall appear on the label.", documentHash: `t-${s}-sa`, coveragePercent: 100, coverageAuditedAt: new Date(), activationMode: "full" } });
    docs.push(sa.id);
    await prisma.regulatoryRule.create({ data: { documentId: sa.id, ruleKey: `SA.TEST.NAME.${s}`, ruleType: "required_field", severity: "error", targetPath: "productName", constraint: { kind: "required_field", path: "productName" }, description: "Product name required.", citation: "The product name shall appear on the label.", confidence: 1, status: "active" } });
    const mk = (country) => prisma.generatedLabel.create({ data: { companyId: coA.id, inputPayload: {}, labelData: SAMPLE_LABEL_DATA, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country, language: "en", status: "draft" } });
    const saLabel = await mk("SA");
    const saVerdicts = (await check(saLabel)).verdicts;
    assert('an "SA" label is checked with the "Saudi Arabia" rules (no "no rules" warning)', !saVerdicts.some((v) => v.ruleKey === "NO_AUTHORITATIVE_REQUIREMENTS") && saVerdicts.some((v) => v.ruleKey === `SA.TEST.NAME.${s}`), saVerdicts.map((v) => v.ruleKey));
    let r;

    const myLabel = await mk("MY");
    let myReport = await check(myLabel);
    assert('Malaysia, no rules: a "not checked" warning that does not fail the check (nothing blocks)', myReport.passed && myReport.verdicts.some((v) => v.ruleKey === "NO_AUTHORITATIVE_REQUIREMENTS" && v.status === "UNVERIFIABLE"), myReport.verdicts.filter((v) => v.status === "FAIL"));

    r = await api("GET", "/regulatory-documents/coverage?country=MY", A);
    assert("coverage MY: 0 rules in force; Saudi Arabia offered to copy from", r.status === 200 && r.data.data.rulesInForce === 0 && r.data.data.copyFrom.some((c) => c.country === "SA" && c.rules >= 1), r.data);
    const stuck = await prisma.regulatoryDocument.create({ data: { title: `stuck ${s}`, country: "Kenya", status: "extracted", companyId: coA.id, extractedText: "x", documentHash: `t-${s}-ke` } });
    docs.push(stuck.id);
    r = await api("GET", "/regulatory-documents/coverage?country=KE", A);
    assert("a document whose reading stopped (no rules, no audit) is shown as stuck — resumable", r.data?.data?.documents?.[0]?.stuck === true && r.data.data.documents[0].id === stuck.id, r.data);

    r = await api("POST", "/regulatory-documents/copy", A, { fromCountry: "Saudi Arabia", toCountry: "MY" });
    const copied = r.data?.data?.documents?.[0];
    if (copied) docs.push(copied.id);
    const copyRow = copied ? await prisma.regulatoryDocument.findUnique({ where: { id: copied.id }, include: { rules: true } }) : null;
    assert("copy SA → MY: a new MY document, its rules with their verbatim citations, NOT in force", r.status === 201 && copyRow?.country === "MY" && copyRow.status === "extracted" && copyRow.sourceType === "copied" && copyRow.rules.length === 1 && copyRow.extractedText.includes(copyRow.rules[0].citation), copyRow && { status: copyRow.status, rules: copyRow.rules.length });
    r = await api("GET", "/regulatory-documents/coverage?country=MY", A);
    assert("…waiting for approval, still 0 rules in force", r.data.data.rulesInForce === 0 && r.data.data.documents.some((d) => d.id === copied?.id && d.awaitingApproval && d.copied), r.data.data);
    assert("…the source country's rules unchanged", (await prisma.regulatoryRule.count({ where: { documentId: sa.id } })) === 1);
    r = await api("POST", "/regulatory-documents/copy", A, { fromCountry: "SA", toCountry: "Saudi Arabia" });
    assert("copying a country onto itself → 400", r.status === 400);
    r = await api("POST", "/regulatory-documents/copy", B, { fromCountry: "Saudi Arabia", toCountry: "MY" });
    assert("another company can't copy company A's own rules (→ 404)", r.status === 404, r.data);

    r = await api("POST", `/regulatory-documents/${copied?.id}/approve`, A, {});
    assert("a person approves the copy → in force", r.status === 200 && r.data.data.document.status === "approved", r.data);
    myReport = await check(myLabel);
    assert("the check again: MY now checked with its rules", !myReport.verdicts.some((v) => v.ruleKey === "NO_AUTHORITATIVE_REQUIREMENTS") && myReport.verdicts.some((v) => v.ruleKey === `SA.TEST.NAME.${s}`), myReport.verdicts.map((v) => v.ruleKey));

    console.log("\nReference labels: a duplicate is the same file");
    const f1 = await labelPdf(["FILE ONE", "Packing: 1 L"]);
    const f2 = await labelPdf(["FILE TWO", "Packing: 1 L"]);
    const up = (headers, files) => api("POST", "/reference-labels", headers, form({ country: "MY" }, ...files.map(([buffer, name]) => ({ field: "files", buffer, name, type: "application/pdf" }))));
    r = await up(A, [[f1, "one.pdf"], [f1, "one (copy).pdf"], [f2, "two.pdf"]]);
    const d = r.data?.data;
    assert("3 files, one sent twice: 2 queued, the copy reported (not silent)", r.status === 202 && d.tasks.length === 2 && d.skipped.length === 1 && d.skipped[0].fileName === "one (copy).pdf" && /same file as one.pdf/.test(r.data.message), r.data);
    const f3 = await labelPdf(["FILE THREE"]);
    await prisma.referenceLabel.create({ data: { name: "three.pdf", companyId: coA.id, country: "MY", sourceType: "upload", sourceSha256: (await import("crypto")).createHash("sha256").update(f3).digest("hex") } });
    r = await up(A, [[f3, "renamed-three.pdf"]]);
    assert("the same file under another name, same company → skipped, saying it's the same file", r.status === 400 && r.data.data.skipped[0]?.fileName === "renamed-three.pdf" && /same file was already uploaded/.test(r.data.message), r.data);
    r = await up(B, [[f3, "three.pdf"]]);
    assert("the same file for another company → queued (its own reference)", r.status === 202 && r.data.data.tasks.length === 1, r.data);
    r = await up(A, [[await labelPdf(["FILE THREE", "corrected"]), "three.pdf"]]);
    assert("a corrected file with the same name → queued (not skipped by name)", r.status === 202 && r.data.data.tasks.length === 1, r.data);
    const mxFiles = fs.existsSync(MAXVET) ? ["label_upload__Maxfort.pdf", "assistant_attachment__1 VITAMAX - 1L.pdf", "catalogue_source__VITA-CMAX - 1 KG.pdf"].map((n) => path.join(MAXVET, n)).filter((p) => fs.existsSync(p)) : [];
    if (mxFiles.length) {
      const coM = await createCompany(`MAXVET${s}`);
      try {
        r = await up(asCompany(coM.id), mxFiles.map((p) => [fs.readFileSync(p), path.basename(p).split("__").pop()]));
        assert(`MAXVET's labels (${mxFiles.length}) at once: all queued, none skipped`, r.status === 202 && r.data.data.tasks.length === mxFiles.length && !r.data.data.skipped.length && !r.data.data.failed.length, r.data);
      } finally {
        await cleanupCompany(coM.id).catch((e) => console.error(e.message));
      }
    } else console.log("  (MAXVET files not on this machine — skipped)");

    console.log("\nProducts in bulk");
    await prisma.product.create({ data: { companyId: coA.id, name: "LIVERCOOL" } });
    const vitamax = await labelPdf(["VITAMAX", "COMPOSITION", "Each 1 Litre contains:", "Vitamin A\t10.000.000 I.U.", "Vitamin D3\t2.000.000 I.U.", "Packing: 1 L", "Form: Oral solution"]);
    const sele = await labelPdf(["SELE GOLD 25", "COMPOSITION", "Each 1 kg contains:", "Selenium\t250 mg", "Packing: 25 kg"]);
    const csv = Buffer.from("Product name,Pack,Code,Colour\nGARLIMYCES,1 L,GM-1,green\nVIAGRAMAX,500 g,VM-5,\n");
    r = await api("POST", "/product-imports", A, form({ text: "AMINOVITA\nLIVERCOOL" }, { field: "files", buffer: vitamax, name: "1 VITAMAX - 1L.pdf", type: "application/pdf" }, { field: "files", buffer: sele, name: "SELE GOLD 25.pdf", type: "application/pdf" }, { field: "files", buffer: csv, name: "products.csv", type: "text/csv" }, { field: "files", buffer: Buffer.from("%!PS-Adobe-3.0"), name: "old.ai", type: "application/postscript" }));
    const imp = r.data?.data;
    assert("2 label files + a sheet (2 rows) + a pasted list (2 lines) → 202: 2 files, 4 rows; the .ai without PDF refused with the reason", r.status === 202 && imp.files === 2 && imp.rows === 4 && imp.refused.length === 1 && /PDF Compatible/.test(imp.refused[0].reason), r.data);
    let t = await api("GET", `/product-imports/${imp.versionId}`, A);
    assert("the sheet and pasted rows are in the table at once (from their cells, no AI)", t.status === 200 && ["GARLIMYCES", "VIAGRAMAX", "AMINOVITA", "LIVERCOOL"].every((n) => t.data.data.rows.some((x) => x.name === n && x.read)), t.data?.data?.rows);
    const gm = t.data.data.rows.find((x) => x.name === "GARLIMYCES");
    assert("…a sheet row: its pack and code, the unknown column listed (never guessed into a field)", gm.packaging === "1 L" && gm.productCode === "GM-1" && gm.flags.some((f) => f.code === "columns_not_used" && /Colour/.test(f.message)), gm);
    assert("…an existing product (LIVERCOOL) is recognised, not saveable", t.data.data.rows.find((x) => x.name === "LIVERCOOL")?.existing && !t.data.data.rows.find((x) => x.name === "LIVERCOOL").saveable);
    // the worker can't read the files without the AI (GEMINI_DISABLED): the stubbed model reads them, one product per file
    if (imp.taskId) await pollTask(imp.taskId, A, { timeoutMs: 60_000 });
    await runExtractJob(imp.versionId, undefined, { generate: labelModel, infer: false });
    t = await api("GET", `/product-imports/${imp.versionId}`, A);
    const vm = t.data.data.rows.find((x) => x.file === "1 VITAMAX - 1L.pdf");
    assert("each label file is ONE product, named after what it prints, with its file", t.data.data.rows.filter((x) => x.file === "1 VITAMAX - 1L.pdf").length === 1 && vm?.name === "VITAMAX" && t.data.data.rows.some((x) => x.file === "SELE GOLD 25.pdf" && x.name === "SELE GOLD 25"), t.data.data.rows.map((x) => [x.file, x.name]));
    assert("…pack, form, composition basis and ingredients as printed (amounts exactly)", vm.packaging === "1 L" && vm.physicalForm === "Oral solution" && vm.compositionBasis === "Each 1 Litre contains:" && vm.ingredients.includes("Vitamin A: 10.000.000 I.U."), vm);
    const selRow = t.data.data.rows.find((x) => x.name === "SELE GOLD 25");
    r = await api("PATCH", `/product-imports/${imp.versionId}/rows/${selRow.id}`, A, { ingredients: "Selenium: 250 mg\nVitamin E: 50 mg", packaging: "25 kg bag" });
    assert("a corrected row: ingredients and pack typed, recorded as typed", r.status === 200 && r.data.data.row.ingredients.includes("Vitamin E: 50 mg") && r.data.data.row.typed.includes("activeIngredients") && r.data.data.row.packaging === "25 kg bag", r.data);
    const via = t.data.data.rows.find((x) => x.name === "VIAGRAMAX");
    r = await api("POST", `/product-imports/${imp.versionId}/rows/${via.id}/skip`, A, {});
    assert("a row skipped (not wanted)", r.status === 200);
    assert("another company can't open the import (→ 404)", (await api("GET", `/product-imports/${imp.versionId}`, B)).status === 404);
    assert("…nor save it", (await api("POST", `/product-imports/${imp.versionId}/save-all`, B, {})).status === 404);

    r = await api("POST", `/product-imports/${imp.versionId}/save-all`, A, {});
    const saved = r.data?.data;
    assert("save all → 4 products (VITAMAX, SELE GOLD 25, GARLIMYCES, AMINOVITA); LIVERCOOL left: already a product", r.status === 201 && saved.created.length === 4 && saved.left.length === 1 && saved.left[0].name === "LIVERCOOL" && /already a product/.test(saved.left[0].reason), saved);
    const pv = await prisma.product.findFirst({ where: { companyId: coA.id, name: "VITAMAX" } });
    assert("VITAMAX: ingredients as printed, the basis on them, each value quoted from its file", pv?.packaging === "1 L" && pv.activeIngredients?.[0]?.amountRaw === "10.000.000 I.U." && pv.activeIngredients[0].basis === "Each 1 Litre contains:" && pv.fieldProvenance?.packaging?.quote === "1 L", pv && { ai: pv.activeIngredients, prov: pv.fieldProvenance?.packaging });
    const ps = await prisma.product.findFirst({ where: { companyId: coA.id, name: "SELE GOLD 25" } });
    assert("SELE GOLD 25: the typed values, with the person's provenance", ps?.packaging === "25 kg bag" && ps.activeIngredients.length === 2 && ps.fieldProvenance?.activeIngredients?.tier === "manual" && ps.fieldProvenance?.packaging?.tier === "manual", ps && ps.fieldProvenance);
    assert("nothing estimated by AI (no Tier I value)", !Object.values(pv.fieldProvenance || {}).some((p) => p?.tier === "I"));
    assert("the skipped row made no product; LIVERCOOL not duplicated", !(await prisma.product.findFirst({ where: { companyId: coA.id, name: "VIAGRAMAX" } })) && (await prisma.product.count({ where: { companyId: coA.id, name: "LIVERCOOL" } })) === 1);
    r = await api("GET", "/product-imports", A);
    assert("the company's imports listed", r.status === 200 && r.data.data.imports.some((x) => x.id === imp.versionId));
    r = await api("POST", "/product-imports", A, form({ text: "" }));
    assert("nothing to import → 400", r.status === 400);
  } finally {
    await prisma.regulatoryDocument.deleteMany({ where: { id: { in: docs } } }).catch((e) => console.error(e.message));
    await cleanupCompany(coA.id).catch((e) => console.error(e.message));
    await cleanupCompany(coB.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
