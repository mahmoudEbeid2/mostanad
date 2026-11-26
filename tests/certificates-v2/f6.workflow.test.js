// The client's certificate workflow (Dossira_Certificate_Workflow_EN, Phase 5): the 8 acceptance rows
// of §6, plus the parts they rest on — request → matrix → review → delivery, the designer's panel,
// composition basis and disagreements, the evidence behind a value. Needs `npm run dev:test`.
import JSZip from "jszip";
import { prisma, api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, confirmStatic } from "./helpers.js";
import { compareAmounts } from "../../src/services/catalogues/compositionCompare.js";
import { recordConflicts } from "../../src/services/catalogues/compositionReview.js";
import { specRange } from "../../src/services/certificates/workflow/reviewService.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const co = await createCompany("f6");
const A = asCompany(co.id);
const lineOf = (v, text) => v.lines.find((l) => l.text.includes(text));
const at = (v, text, sample = text) => {
  const l = lineOf(v, text);
  const s = l.text.indexOf(sample);
  return { lineId: l.id, charStart: s, charEnd: s + sample.length, sampleValue: sample };
};

/** a PHARMAVET design with the given fields, the rest confirmed static, prepared and active */
async function template(name, typeId, fields, { scope = "per_product", country } = {}) {
  const up = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name, certificateTypeId: typeId, scope, country });
  if (!up.version) throw new Error(`upload ${up.status} ${JSON.stringify(up.data)}`);
  const v = up.version;
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields: fields(v) });
  if (r.status !== 200) throw new Error(`fields ${JSON.stringify(r.data)}`);
  await confirmStatic(v.id, A);
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const t = await pollTask(r.data.data.taskId, A, { timeoutMs: 180_000 });
  if (t?.status !== "completed") throw new Error(`prepare ${t?.status}`);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`activate ${JSON.stringify(r.data)}`);
  return { templateId: up.data.data.templateId, versionId: v.id };
}
const name = (v) => ({ key: "product_name", label: "Product name", ...at(v, "DOXYPHARMA"), source: { kind: "product", path: "name" }, required: true });

try {
  const types = {};
  for (const [code, n] of [["COA", "Certificate of Analysis"], ["COC", "Certificate of Composition"], ["HC", "Health Certificate"], ["FSC", "Free Sale Certificate"]]) types[code] = (await api("POST", "/certificate-types", A, { code, name: n })).data.data.type;
  await template("COA", types.COA.id, (v) => [name(v), { key: "batch_no", label: "Batch number", ...at(v, "HSPhar02509001"), source: { kind: "item", path: "batchNo" }, required: true }, { key: "ph_spec", label: "pH specification", ...at(v, "2.0 – 3.0"), source: { kind: "static", text: "3.5–4.5" }, required: true }, { key: "ph_result", label: "pH result", ...at(v, "2.6"), source: { kind: "manual" }, required: true, isLabResult: true, specFieldKey: "ph_spec" }]);
  await template("COC", types.COC.id, (v) => [name(v), { key: "pack", label: "Packing", ...at(v, "1KG"), source: { kind: "product", path: "packaging" }, required: true }, { key: "basis", label: "Composition basis", ...at(v, "(per gm)", "per gm"), source: { kind: "product", path: "compositionBasis" }, required: true }, { key: "amount", label: "Amount", ...at(v, "500 mg"), source: { kind: "product", path: "activeIngredients[0].concentration" }, required: true }]);
  await template("FSC", types.FSC.id, (v) => [{ key: "issued", label: "Issue", ...at(v, "09/2028"), source: { kind: "static", text: "2026" }, required: true }], { scope: "per_invoice" });

  const P = async (n, extra = {}) => prisma.product.create({ data: { companyId: co.id, name: n, ...extra } });
  const hemozex50 = await P("HEMOZEX", { packaging: "50 mL", compositionBasis: "per 100 mL", activeIngredients: [{ name: "Folic acid", concentration: "64 mg", amountRaw: "64 mg", basis: "per 100 mL" }] });
  await P("HEMOZEX", { packaging: "100 mL" });
  const livatomic = await P("LIVATOMIC", { packaging: "100 mL", compositionBasis: "per 1 mL", physicalForm: "Liquid", activeIngredients: [["DL-Methionine", "100 mg"], ["Choline Bitartrate", "100 mg"], ["Silymarin", "25 mg"], ["Purified Water", "q.s. to 1 mL"]].map(([n, a]) => ({ name: n, concentration: a, amountRaw: a, basis: "per 1 mL" })) });
  const zyrax = await P("ZYRAX 10");

  console.log("§6.1 · two pasted names, no invoice");
  let r = await api("POST", "/certificate-requests", A, { text: "LIVATOMIC\nZYRAX 10" });
  const req1 = r.data?.data;
  const cells = (req) => req.rows.flatMap((x) => Object.values(x.cells));
  assert("→ two ordered lines and eight status cells (COA, COC, HC, FSC each)", r.status === 201 && req1.rows.map((x) => x.product).join("|") === "LIVATOMIC|ZYRAX 10" && cells(req1).length === 8 && req1.codes.join() === "COA,COC,HC,FSC", req1?.rows?.map((x) => x.product));
  assert("…every cell «awaiting inputs» before anything is made, with what it needs", cells(req1).every((c) => c.status === "awaiting_inputs" && c.missing.length), cells(req1).map((c) => c.missing[0]?.code));
  assert("…HC has no template yet: said, not hidden", req1.rows[0].cells.HC.missing[0].code === "no_template", req1.rows[0].cells.HC);

  console.log("\n§6.2 · the same product in two pack sizes");
  r = await api("POST", "/certificate-requests", A, { lines: [{ name: "HEMOZEX", packing: "50 mL" }, { name: "HEMOZEX" }] });
  const req2 = r.data?.data;
  assert("both lines kept; the one with its pack matched, the other asks which HEMOZEX (2 candidates)", req2.rows.length === 2 && req2.rows[0].match === "matched" && req2.rows[0].productId === hemozex50.id && req2.rows[1].match === "ambiguous" && req2.rows[1].candidates.length === 2, req2.rows.map((x) => `${x.match}:${x.candidates.length}`));
  r = await api("POST", `/certificate-requests/${req2.request.id}/generate`, A);
  assert("…nothing is generated while a line is unclear", r.status === 409 && r.data.code === "LINES_UNCLEAR", r.data);
  r = await api("PATCH", `/certificate-requests/${req2.request.id}/lines/${req2.rows[1].lineId}`, A, { productId: req2.rows[1].candidates.find((c) => c.packaging === "100 mL").id });
  assert("…the reviewer picks the 100 mL one → matched", r.status === 200 && r.data.data.rows[1].match === "matched", r.data);

  console.log("\n§6.3 · a basis different from the pack size");
  r = await api("POST", "/certificate-requests", A, { lines: [{ productId: hemozex50.id, lotNo: "HZ-2611" }], certificateCodes: ["COC"] });
  const req3 = r.data.data;
  r = await api("POST", `/certificate-requests/${req3.request.id}/generate`, A);
  await pollTask(r.data?.data?.taskId, A, { timeoutMs: 180_000 });
  const coc = await prisma.certificate.findFirst({ where: { invoiceId: req3.request.id }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  const cv = coc?.versions[0]?.values || {};
  assert("the COC shows pack 50 mL AND basis per 100 mL, the declared 64 mg unchanged", cv.pack?.value === "50 mL" && cv.basis?.value === "per 100 mL" && cv.amount?.value === "64 mg", { pack: cv.pack?.value, basis: cv.basis?.value, amount: cv.amount?.value });
  const cmp = compareAmounts({ amount: "0.1 mg/mL" }, { amount: "0.64 g", basis: "per 100 mL" });
  assert("two sources compared on one basis: «10 mg vs 640 mg per 100 mL»", cmp.text === "10 mg vs 640 mg per 100 mL");
  const added = await recordConflicts(await prisma.product.findUnique({ where: { id: hemozex50.id } }), { ingredients: [{ name: "Folic acid", amountRaw: "0.64 g" }], basis: "per 100 mL", source: { file: "label.pdf", page: 1 } });
  r = await api("GET", `/products/${hemozex50.id}/composition-review`, A);
  assert("…a disagreement is kept with BOTH values, the comparison, and nothing changed yet", added.length === 1 && r.data.data.conflicts[0].values.length === 2 && /640 mg per 100 mL/.test(r.data.data.conflicts[0].comparison) && !r.data.data.conflicts[0].decision, r.data.data);
  r = await api("POST", `/products/${hemozex50.id}/composition-review/0/decide`, A, { chosen: 0, reason: "the manufacturer confirmed 64 mg per 100 mL" });
  assert("…the reviewer's decision and reason are recorded; the value used is the confirmed one", r.status === 200 && r.data.data.conflicts[0].decision.reason.includes("confirmed") && (await prisma.product.findUnique({ where: { id: hemozex50.id } })).activeIngredients[0].amountRaw === "64 mg", r.data);

  console.log("\n§6.4 / §6.5 · no lab report; a pH out of its specification");
  r = await api("POST", "/certificate-requests", A, { lines: [{ productId: livatomic.id, lotNo: "LV-2611" }], certificateCodes: ["COA", "COC"] });
  const req4 = r.data.data;
  r = await api("POST", `/certificate-requests/${req4.request.id}/generate`, A);
  await pollTask(r.data?.data?.taskId, A, { timeoutMs: 180_000 });
  let m = (await api("GET", `/certificate-requests/${req4.request.id}`, A)).data.data;
  assert("the batch has no lab report: its COA waits for it (named), the COC goes on as a draft", m.rows[0].cells.COA.status === "awaiting_inputs" && m.rows[0].cells.COA.missing[0].code === "lab_report" && /pH result/.test(m.rows[0].cells.COA.missing[0].ar) && m.rows[0].cells.COC.status === "draft", m.rows[0].cells);
  const coa = await prisma.certificate.findUnique({ where: { id: m.rows[0].cells.COA.certificateId } });
  r = await api("PATCH", `/certificates/${coa.id}/values`, A, { expectedVersion: coa.currentVersion, changes: { ph_result: "3.3" } });
  const checks = (await api("GET", `/certificates/${coa.id}/review-checks`, A)).data.data;
  assert("pH 3.3 typed against 3.5–4.5 → review flags it, the recorded 3.3 kept", checks.outOfSpec.some((x) => x.field === "ph_result" && x.value === "3.3" && x.spec === "3.5–4.5") && specRange("3.5–4.5").min === 3.5, checks);

  console.log("\n§5 · review → authorization → approved → exported; a field-specific return");
  const cocCert = m.rows[0].cells.COC.certificateId;
  r = await api("POST", `/certificates/${cocCert}/review`, A, { action: "submit" });
  assert("draft → in review", r.status === 200 && r.data.data.certificate.reviewStatus === "in_review", r.data);
  r = await api("POST", `/certificates/${cocCert}/review`, A, { action: "return", comment: "the basis is per 1 mL" });
  assert("a return without the field is refused", r.status === 400);
  r = await api("POST", `/certificates/${cocCert}/review`, A, { action: "return", field: "basis", comment: "check the basis against the formulation" });
  m = (await api("GET", `/certificate-requests/${req4.request.id}`, A)).data.data;
  assert("returned with a comment on «basis» → back to draft, the comment on the cell", m.rows[0].cells.COC.status === "draft" && m.rows[0].cells.COC.comments.some((c) => c.field === "basis"), m.rows[0].cells.COC);
  for (const action of ["submit", "pass"]) r = await api("POST", `/certificates/${cocCert}/review`, A, { action });
  m = (await api("GET", `/certificate-requests/${req4.request.id}`, A)).data.data;
  assert("resubmitted and passed → awaiting authorization", m.rows[0].cells.COC.status === "awaiting_authorization", m.rows[0].cells.COC);
  r = await api("POST", `/certificates/${cocCert}/review`, A, { action: "authorize" });
  m = (await api("GET", `/certificate-requests/${req4.request.id}`, A)).data.data;
  assert("authorized → approved (final, frozen)", r.status === 200 && m.rows[0].cells.COC.status === "approved", r.data);

  console.log("\n§6.6 · one FSC covers three products");
  r = await api("POST", "/certificate-requests", A, { lines: [{ productId: livatomic.id }, { productId: hemozex50.id }, { productId: zyrax.id }], certificateCodes: ["FSC"] });
  const req6 = r.data.data;
  r = await api("POST", `/certificate-requests/${req6.request.id}/generate`, A);
  const batchId = r.data?.data?.batchId;
  await pollTask(r.data?.data?.taskId, A, { timeoutMs: 180_000 });
  m = (await api("GET", `/certificate-requests/${req6.request.id}`, A)).data.data;
  const fscIds = new Set(m.rows.map((x) => x.cells.FSC.certificateId));
  assert("all three cells link to the same FSC", fscIds.size === 1 && [...fscIds][0] && m.rows.every((x) => x.cells.FSC.shared), m.rows.map((x) => x.cells.FSC));
  const fsc = [...fscIds][0];
  for (const action of ["submit", "pass", "authorize"]) await api("POST", `/certificates/${fsc}/review`, A, { action });
  r = await api("POST", `/certificate-batches/${batchId}/export`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 180_000 });
  const z1 = await api("GET", `/certificate-batches/${batchId}/zip`, A);
  const zip = await JSZip.loadAsync(z1.buffer);
  const pdfs = Object.keys(zip.files).filter((n) => n.endsWith(".pdf"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert("the ZIP: ONE FSC file (in FSC/), and the manifest says it covers the 3 lines in order", pdfs.length === 1 && pdfs[0].startsWith("FSC/") && manifest.documents[0].covers.map((c) => c.line).join() === "1,2,3", { pdfs, covers: manifest.documents[0]?.covers });
  m = (await api("GET", `/certificate-requests/${req6.request.id}`, A)).data.data;
  assert("…approved and delivered → «exported»", m.rows.every((x) => x.cells.FSC.status === "exported"), m.rows.map((x) => x.cells.FSC.status));
  r = await api("POST", `/certificate-batches/${batchId}/export`, A);
  await pollTask(r.data.data.taskId, A, { timeoutMs: 180_000 });
  const z2 = await api("GET", `/certificate-batches/${batchId}/zip`, A);
  assert("re-exporting the same revision gives the same ZIP, byte for byte", Buffer.compare(z1.buffer, z2.buffer) === 0);
  const zip4 = (await api("POST", `/certificate-batches/${(await prisma.certificate.findUnique({ where: { id: cocCert } })).batchId}/export`, A)).data.data;
  await pollTask(zip4.taskId, A, { timeoutMs: 180_000 });
  const zipCoc = await JSZip.loadAsync((await api("GET", `/certificate-batches/${(await prisma.certificate.findUnique({ where: { id: cocCert } })).batchId}/zip`, A)).buffer);
  const out4 = JSON.parse(await zipCoc.file("manifest.json").async("string")).outstanding;
  assert("partial delivery: the manifest lists what is outstanding (the COA, not approved yet) and what it needs", out4.some((o) => o.code === "COA" && o.status === "draft" && o.needs.some((n) => /تتعتمد/.test(n))) && !out4.some((o) => o.code === "COC") && zipCoc.file("outstanding.txt"), out4);

  console.log("\n§6.7 · the designer copies ingredients and quantities separately");
  const d = (await api("GET", `/products/${livatomic.id}/designer?requestId=${req1.request.id}`, A)).data.data;
  const names = d.tsv.names.split("\n");
  const qty = d.tsv.quantities.split("\n");
  assert("the order: Product Name → Packing Size → Type → Form → Composition Basis → Ingredients → Quantities → Appearance → pH", d.fields.map((f) => f.key).join() === "name,packaging,type,form,compositionBasis,ingredients,quantities,appearance,ph");
  assert("names and quantities: same row count and order; units and «q.s. to 1 mL» kept", names.length === 4 && qty.length === 4 && names[3] === "Purified Water" && qty[3] === "q.s. to 1 mL" && qty[0] === "100 mg");
  assert("the whole table is tab-separated, one ingredient per row (the document's example)", d.tsv.table === "DL-Methionine\t100 mg\nCholine Bitartrate\t100 mg\nSilymarin\t25 mg\nPurified Water\tq.s. to 1 mL", d.tsv.table);
  assert("the shipment columns: description, packing size, lot, lot size", /Description\tPacking size\tLot\tLot size/.test(d.tsv.shipment), d.tsv.shipment);
  r = await api("PUT", `/products/${livatomic.id}/design-estimates`, A, { ph: "6.5" });
  assert("an estimate without its assumptions is refused", r.status === 400);
  r = await api("PUT", `/products/${livatomic.id}/design-estimates`, A, { ph: "≈ 6.5", appearance: "clear yellow liquid", assumptions: "aqueous vehicle, measured undiluted" });
  const ph = r.data.data.fields.find((f) => f.key === "ph");
  assert("…with them: shown in the design fields as an estimate", ph.value === "≈ 6.5" && ph.estimate === true);
  const src = (await api("GET", "/certificate-field-sources", A)).data?.data;
  assert("…and a certificate can never read it (not a field source)", !JSON.stringify(src).includes("designEstimates") && JSON.stringify(src).includes("compositionBasis"));

  console.log("\n§6.8 · a correction after issue");
  r = await api("POST", `/certificates/${cocCert}/revise`, A);
  const rev = r.data?.data?.certificate;
  assert("an approved certificate is revised → a NEW draft, revision 2; the approved one stays as it was", r.status === 201 && rev.revisionNumber === 2 && rev.revisionOfId === cocCert && (await prisma.certificate.findUnique({ where: { id: cocCert } })).status === "final", r.data);
  r = await api("PATCH", `/certificates/${rev.id}/values`, A, { expectedVersion: rev.currentVersion, changes: { basis: "per 2 mL" } });
  r = await api("GET", `/certificates/${rev.id}/changes`, A);
  assert("…the revision shows what changed against the approved one (basis per 1 mL → per 2 mL)", r.data.data.changes.length === 1 && r.data.data.changes[0].field === "basis" && r.data.data.changes[0].before === "per 1 mL" && r.data.data.changes[0].after === "per 2 mL", r.data.data);
  m = (await api("GET", `/certificate-requests/${req4.request.id}`, A)).data.data;
  assert("…and the matrix shows the newest revision (a draft again)", m.rows[0].cells.COC.certificateId === rev.id && m.rows[0].cells.COC.revision === 2, m.rows[0].cells.COC);

  console.log("\n§2.3 · the evidence behind a value");
  const file = await fileStore.putFile({ companyId: co.id, kind: "intake_file", buffer: Buffer.from("%PDF-1.4 source"), mimeType: "application/pdf" });
  {
    await prisma.product.update({ where: { id: livatomic.id }, data: { fieldProvenance: { packaging: { source: "intake", file: "LIVATOMIC COC.pdf", fileId: file.id, page: 3 } } } });
    const d2 = (await api("GET", `/products/${livatomic.id}/designer`, A)).data.data;
    assert("a value from a file links to that file's page", d2.fields.find((f) => f.key === "packaging").evidence.link === `/api/v1/evidence-files/${file.id}#page=3`);
    const other = await createCompany("f6b");
    assert("another company can't open it (404)", (await api("GET", `/evidence-files/${file.id}`, asCompany(other.id))).status === 404);
    await cleanupCompany(other.id);
  }
} catch (err) {
  assert(`no crash: ${err.stack}`, false);
} finally {
  await cleanupCompany(co.id);
  await prisma.$disconnect();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}
