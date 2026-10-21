// Certificates V2 Phase 7 — repeating groups through the API and the workers
// (CERTIFICATES_V2_PLAN.md §7.8, §8.2, §10.3, §11). The engine's geometry is
// covered by p7.groups.golden.test.js; this suite covers the contract:
//  - a group on a PNG version → 409 GROUP_NEEDS_SVG; enable-groups → a NEW
//    draft version, SVG background, fields copied, its own prepare gate
//  - PUT /fields with groups: detection result (shape, footer proposal,
//    capacity), the user's footer line, validation (sources vs scope, cells,
//    keys), draft-only
//  - prepare → report.groups; activate; sample + preview
//  - generation: product_list (per_product) and invoice_lines (per_invoice)
//  - editor: rows added / removed / reordered / edited = new versions;
//    invalid rows refused; reset to the source; overflow blocks finalize
//  - tenancy: every group route is 404 to another company
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service with ?bg=svg.
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma } from "./helpers.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const coA = await createCompany("p7a");
const coB = await createCompany("p7b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

const at = (lines, lineId, v, last = false) => {
  const t = lines.find((l) => l.id === lineId)?.text || "";
  const s = last ? t.lastIndexOf(v) : t.indexOf(v);
  return { charStart: s, charEnd: s + v.length };
};
// the golden's plain fields, minus the constituent slots the group replaces
const plainFields = (file, lines) =>
  golden[file]
    .filter((g) => !g.key.startsWith("constituent"))
    .map(({ occurrence, ...g }, i) => ({ ...g, sortOrder: i, ...at(lines, g.lineId, g.sampleValue, occurrence === "last") }));
const cell = (lines, key, lineId, v, source, last = false) => ({ key, label: key, lineId, sampleValue: v, source, align: "left", page: 1, sortOrder: 100 + (key === "amount" ? 1 : 0), groupKey: "constituents", ...at(lines, lineId, v, last) });

const ADD_CELLS = (lines, kind = "row") => [
  cell(lines, "name", "p1-l22", "Vitamin E", kind === "row" ? { kind: "row", path: "name" } : { kind: "manual" }),
  cell(lines, "amount", "p1-l25", "120000 mg", kind === "row" ? { kind: "row", path: "concentration" } : { kind: "manual" }),
];
const group = (source, extra = {}) => ({ key: "constituents", label: "Constituents", source, whenEmpty: "dash", required: true, ...extra });

const getVersion = async (id, h = A) => (await api("GET", `/template-versions/${id}`, h)).data?.data?.version;
const getCert = async (id) => (await api("GET", `/certificates/${id}`, A)).data?.data?.certificate;
const htmlOf = async (id, version) => (await api("GET", `/certificates/${id}/html${version ? `?version=${version}` : ""}`, A)).buffer.toString("utf8");

async function prepareAndActivate(versionId) {
  let r = await api("POST", `/template-versions/${versionId}/prepare`, A);
  const task = await pollTask(r.data?.data?.taskId, A, { timeoutMs: 180_000 });
  const v = await getVersion(versionId);
  r = v?.status === "ready" ? await api("POST", `/template-versions/${versionId}/activate`, A) : null;
  return { task, version: v, activate: r };
}

async function readyInvoice(companyId, lines) {
  const src = await fileStore.putFile({ companyId, kind: "invoice_source", buffer: fs.readFileSync(path.join(FIXTURES, "outlined_text.pdf")), mimeType: "application/pdf" });
  const header = { invoiceNo: "INV-P7", invoiceDate: { raw: "20/10/2026", iso: "2026-10-20" } };
  const inv = await prisma.invoice.create({ data: { companyId, status: "ready", sourceFileId: src.id, header, headerExtracted: header, extraction: { modelId: "test", promptHash: "test" } } });
  for (const [i, l] of lines.entries()) {
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data: l.data, dataExtracted: l.data, productId: l.productId, matchStatus: "matched", matchMethod: "user" } });
  }
  return inv;
}

async function generate(invoiceId) {
  const r = await api("POST", `/invoices/${invoiceId}/generate`, A);
  const task = await pollTask(r.data?.data?.taskId, A, { timeoutMs: 240_000 });
  const list = (await api("GET", `/certificates?batchId=${r.data?.data?.batchId}&limit=50`, A)).data?.data?.certificates || [];
  return { r, task, list };
}

async function pdfText(certId) {
  const r = await api("POST", `/certificates/${certId}/export-pdf`, A);
  const task = await pollTask(r.data?.data?.taskId, A, { timeoutMs: 120_000 });
  const pdf = await api("GET", `/certificates/${certId}/pdf`, A);
  if (!pdf.buffer) return { task, pages: 0, text: "" };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.buffer), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  return { task, pages: doc.numPages, size: page.view.slice(2), text: (await page.getTextContent()).items.map((i) => i.str).join("").replace(/\s+/g, "") };
}

const squash = (t) => String(t).replace(/\s+/g, "");
const INGREDIENTS = [
  { name: "Vitamin E", concentration: "120000 mg" },
  { name: "Sodium selenite", concentration: "60 mg" },
  { name: "Vitamin K3", concentration: "2000 mg" },
  { name: "Folic acid", concentration: "300 mg" },
  { name: "Nicotinamide", concentration: "15000 mg" },
];

try {
  console.log("\n🧪 Setup");
  const typeId = (await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "COA" })).data.data.type.id;
  const product = await prisma.product.create({ data: { companyId: coA.id, name: "ADD-E120", activeIngredients: INGREDIENTS } });
  const doxy = await prisma.product.create({ data: { companyId: coA.id, name: "Doxycycline hyclate", activeIngredients: [{ name: "Doxycycline", concentration: "500 mg" }] } });

  const add = await uploadTemplate(coA.id, { file: "ADDVET_COA.ai", name: "ADDVET groups", certificateTypeId: typeId, scope: "per_product" });
  const v1 = add.version;
  assert("v1 converts with the default PNG background", v1?.status === "draft" && v1.backgroundFormat === "png", v1 && { status: v1.status, bg: v1.backgroundFormat });
  let r = await api("PUT", `/template-versions/${v1.id}/fields`, A, { fields: plainFields("ADDVET_COA.ai", v1.lines) });
  assert("plain fields on v1 (no groups) — unchanged behaviour", r.status === 200 && r.data.data.groups.length === 0, r.data);

  console.log("\n🧪 A group needs an SVG version (decision 3)");
  r = await api("PUT", `/template-versions/${v1.id}/fields`, A, { fields: [...plainFields("ADDVET_COA.ai", v1.lines), ...ADD_CELLS(v1.lines)], groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  assert("group on a PNG version → 409 GROUP_NEEDS_SVG naming enable-groups", r.status === 409 && r.data?.code === "GROUP_NEEDS_SVG" && /enable-groups/.test(r.data?.message), r.data);
  r = await api("POST", `/template-versions/${v1.id}/enable-groups`, B);
  assert("enable-groups — another company → 404", r.status === 404, r.status);
  r = await api("POST", `/template-versions/${v1.id}/enable-groups`, A);
  assert("enable-groups → 202 with a NEW version number and a task", r.status === 202 && r.data.data.versionNumber === 2 && r.data.data.taskId, r.data);
  const v2id = r.data.data.versionId;
  const conv = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  let v2 = await getVersion(v2id);
  assert("v2 converted: draft, SVG background, based on v1, its plain fields copied, no prepare report", conv?.status === "completed" && v2.status === "draft" && v2.backgroundFormat === "svg" && v2.basedOnVersionId === v1.id && v2.fields.length === plainFields("ADDVET_COA.ai", v1.lines).length && !v2.prepareReport, { task: conv?.status, status: v2?.status, bg: v2?.backgroundFormat, fields: v2?.fields?.length });
  assert("v2's text layer is v1's (no LINES_CHANGED warning)", !(v2.conversion?.warnings || []).some((w) => String(w).startsWith("LINES_CHANGED")), v2.conversion?.warnings);
  assert("v1 is untouched (still PNG, still draft)", (await getVersion(v1.id)).backgroundFormat === "png");
  r = await api("POST", `/template-versions/${v2id}/enable-groups`, A);
  assert("enable-groups on an SVG version → 409 ALREADY_SVG", r.status === 409 && r.data?.code === "ALREADY_SVG", r.data);

  console.log("\n🧪 Marking a group (PUT /fields with groups)");
  const fields = [...plainFields("ADDVET_COA.ai", v2.lines), ...ADD_CELLS(v2.lines)];
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "invoice_lines" })] });
  assert("invoice lines on a per-product template → 422 naming the scope", r.status === 422 && JSON.stringify(r.data).includes("per-invoice"), r.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "nope" })] });
  assert("unknown product list → 422", r.status === 422 && JSON.stringify(r.data).includes("unknown product list"), r.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields: fields.map((f) => (f.groupKey ? { ...f, source: { kind: "row", path: "nope" } } : f)), groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  assert("a cell reading an unknown row path → 422", r.status === 422 && JSON.stringify(r.data).includes("unknown row path"), r.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" }, { key: "batch_no" })] });
  assert("group key = a field key → 422", r.status === 422, r.status);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" }, { whenEmpty: "blank" })] });
  assert("unknown whenEmpty → 422", r.status === 422 && JSON.stringify(r.data).includes("whenEmpty"), r.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" }, { minPitchRatio: 0.7 })] });
  assert("minPitchRatio below 85 % → 422 (owner decision 4)", r.status === 422 && JSON.stringify(r.data).includes("minPitchRatio"), r.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, B, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  assert("PUT /fields — another company → 404", r.status === 404, r.status);

  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  const det = r.data?.data?.groupDetection?.constituents;
  assert("group saved: detected as a list inside one cell, 3 sample rows, footer line proposed, capacity", r.status === 200 && det?.ok && det.shape === "cell_list" && det.sampleRowCount === 3 && det.footerProposal > 700 && det.capacity?.min >= det.capacity?.full, r.data?.data?.groupDetection || r.data);
  assert("response lists the group with its defaults", r.data.data.groups[0]?.key === "constituents" && r.data.data.groups[0].whenEmpty === "dash" && r.data.data.groups[0].mode === "repeat" && r.data.data.groups[0].footerY === null);

  // the user drags the footer line up: less room → fewer rows fit
  const dragged = Math.round(det.footerProposal - 60);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" }, { footerY: dragged })] });
  const det2 = r.data?.data?.groupDetection?.constituents;
  assert(`the user's footer line is used (${dragged}) and capacity drops`, r.status === 200 && det2?.footerY === dragged && det2.footerProposal === det.footerProposal && det2.capacity.min < det.capacity.min, det2);
  // back to the proposal for the rest of the suite
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  v2 = await getVersion(v2id);
  assert("GET version returns groups and a hash that covers them", v2.groups?.length === 1 && v2.fieldsHash, v2.groups);
  const src = (await api("GET", "/certificate-field-sources", A)).data?.data;
  assert("source catalogue lists group sources, cell kinds, modes and whenEmpty", src?.groups?.kinds?.length === 3 && src.groups.kinds.find((k) => k.kind === "product_list")?.lists?.[0]?.path === "activeIngredients" && src.groups.modes.length === 2 && src.groups.whenEmpty.length === 2, src?.groups);

  console.log("\n🧪 Prepare → ready → activate");
  let p = await prepareAndActivate(v2id);
  const rep = p.version?.prepareReport;
  assert("prepare passes with the group: groups check, round-trip ≤ 0.05 %", p.version?.status === "ready" && rep?.passed && rep.checks.some((c) => c.id === "groups" && c.passed) && rep.pixelDiffPct <= 0.05, rep && { passed: rep.passed, failing: rep.checks.filter((c) => !c.passed), px: rep.pixelDiffPct });
  assert("report.groups describes the group (shape, capacity)", rep?.groups?.constituents?.ok && rep.groups.constituents.shape === "cell_list", rep?.groups);
  assert("activate → 200", p.activate?.status === 200, p.activate?.data);
  r = await api("PUT", `/template-versions/${v2id}/fields`, A, { fields, groups: [group({ kind: "product_list", path: "activeIngredients" })] });
  assert("an active version's groups can't change → 409 VERSION_NOT_DRAFT", r.status === 409 && r.data?.code === "VERSION_NOT_DRAFT", r.data);
  r = await api("GET", `/template-versions/${v2id}/html?variant=sample`, A);
  const sample = r.buffer?.toString("utf8") || "";
  assert("sample render shows the design's own 3 rows", ["Vitamin E", "Sodium selenite", "Distillate water up to"].every((t) => sample.includes(t)), r.status);

  r = await api("POST", `/template-versions/${v2id}/preview`, A, { productId: product.id, values: { ph_result: "4.1" } });
  const pv = r.data?.data;
  assert("preview with a product: 5 rows from activeIngredients, no flags", r.status === 200 && pv.values.constituents.rows.length === 5 && pv.values.constituents.rows[1].name === "Sodium selenite" && pv.values.constituents.rows[1].amount === "60 mg" && !(pv.flags.constituents || []).length, pv?.values?.constituents || r.data);
  r = await api("POST", `/template-versions/${v2id}/preview`, A, { values: { constituents: [] } });
  assert("preview with typed rows [] → dash row, flagged missing (required)", r.status === 200 && r.data.data.flags.constituents.includes("missing") && r.data.data.html.includes("—"), r.data?.data?.flags);

  console.log("\n🧪 Generation — per_product, rows from the product's list");
  const inv = await readyInvoice(coA.id, [{ data: { name: "ADD-E120", batchNo: "AVVS1124001", expiryDate: { raw: "11/2027", iso: "2027-11-01" }, productionDate: { raw: "11/2024", iso: "2024-11-01" } }, productId: product.id }]);
  let g = await generate(inv.id);
  assert("generate → batch completed with 1 certificate", g.task?.status === "completed" && g.list.length === 1, { task: g.task?.status, err: g.task?.error, n: g.list.length });
  const certId = g.list[0]?.id;
  let cert = await getCert(certId);
  const cv = cert?.values?.constituents;
  assert("certificate value is a group: 5 rows in the product's order, source + origin auto", cv?.kind === "group" && cv.rows.length === 5 && cv.rows.map((x) => x.name).join("|") === INGREDIENTS.map((x) => x.name).join("|") && cv.origin === "auto", cv);
  assert("GET certificate lists the group with its cells and capacity", cert.groups?.[0]?.key === "constituents" && cert.groups[0].cells.map((c) => c.key).join(",") === "name,amount" && cert.groups[0].capacity?.min > 5, cert.groups);
  assert("group cells are listed as fields with their groupKey", cert.fields.filter((f) => f.groupKey === "constituents").length === 2);
  let html = await htmlOf(certId);
  assert("certificate HTML has every ingredient", INGREDIENTS.every((i) => html.includes(i.name) && html.includes(i.concentration)));

  console.log("\n🧪 Editor — rows are values; every change is a new version");
  let ver = cert.currentVersion;
  const rows = cv.rows;
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: [rows[1], rows[0], ...rows.slice(2)] } });
  assert("reorder → new version, summary 'rows reordered'", r.status === 200 && r.data.data.version === ver + 1, r.data);
  ver++;
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: [...rows, { name: "Biotin", amount: "50 mg" }] } });
  assert("add a row → new version", r.status === 200 && r.data.data.version === ver + 1, r.data);
  ver++;
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: rows.slice(0, 2) } });
  assert("remove rows → new version", r.status === 200, r.data);
  ver++;
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: [{ ...rows[0], amount: "125000 mg" }, rows[1]] } });
  assert("edit a cell → new version", r.status === 200, r.data);
  ver++;
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: [{ ...rows[0], amount: "125000 mg" }, rows[1]] } });
  assert("the same rows again → no new version", r.status === 200 && r.data.data.version === ver, r.data?.data?.version);
  cert = await getCert(certId);
  assert("stored: 2 rows, origin manual, edited cell kept", cert.values.constituents.rows.length === 2 && cert.values.constituents.origin === "manual" && cert.values.constituents.rows[0].amount === "125000 mg", cert.values.constituents);
  const versions = (await api("GET", `/certificates/${certId}/versions`, A)).data?.data?.versions || [];
  const summaries = versions.map((v) => v.changeSummary).join(" / ");
  assert("version summaries say what happened to the rows", /rows reordered/.test(summaries) && /5 rows → 6 rows/.test(summaries) && /6 rows → 2 rows/.test(summaries) && /1 row edited/.test(summaries), summaries);
  html = await htmlOf(certId);
  assert("v1 HTML still has 5 rows; current has 2 with the edit", (await htmlOf(certId, 1)).includes("Nicotinamide") && !html.includes("Nicotinamide") && html.includes("125000 mg"));

  for (const [label, changes, code] of [
    ["a group sent as text", { constituents: "Vitamin E" }, "INVALID_ROWS"],
    ["an unknown cell", { constituents: [{ name: "x", colour: "red" }] }, "UNKNOWN_FIELD"],
    ["a plain field sent as rows", { ph_result: [{ name: "x" }] }, "INVALID_VALUE"],
  ]) {
    r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes });
    assert(`${label} → 422 ${code}`, r.status === 422 && r.data?.code === code, r.data);
  }
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: ["Vitamin E"] } });
  assert("a row that isn't an object → 400 at the request validator", r.status === 400, r.data);
  r = await api("PATCH", `/certificates/${certId}/values`, B, { expectedVersion: ver, changes: { constituents: [] } });
  assert("rows edit — another company → 404", r.status === 404, r.status);

  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: Array.from({ length: 30 }, (_, i) => ({ name: `Ingredient ${i + 1}`, amount: `${i + 1} mg` })) } });
  ver++;
  cert = await getCert(certId);
  const capacity = cert.groups[0].capacity.min;
  assert(`30 rows → flagged overflow, ${capacity} rows fit (rowsFit)`, r.status === 200 && cert.values.constituents.flags.includes("overflow") && cert.values.constituents.rowsFit === capacity, cert.values.constituents);
  r = await api("POST", `/certificates/${certId}/finalize`, A, { expectedVersion: ver });
  assert("finalize with overflow → 409 CERTIFICATE_FLAGGED naming the group", r.status === 409 && r.data?.code === "CERTIFICATE_FLAGGED" && r.data.flags?.constituents?.includes("overflow"), r.data);

  r = await api("POST", `/certificates/${certId}/fields/constituents/reset`, A, { expectedVersion: ver });
  ver++;
  cert = await getCert(certId);
  assert("reset the group → back to the product's 5 rows, origin auto", r.status === 200 && cert.values.constituents.rows.length === 5 && cert.values.constituents.origin === "auto" && !cert.values.constituents.flags.includes("overflow"), cert.values.constituents);

  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: [], ph_result: "4.1" } });
  ver++;
  cert = await getCert(certId);
  assert("0 rows on a required group → missing (dash row)", cert.values.constituents.flags.includes("missing") && (await htmlOf(certId)).includes("—"), cert.values.constituents.flags);
  r = await api("PATCH", `/certificates/${certId}/values`, A, { expectedVersion: ver, changes: { constituents: rows.slice(0, 3) } });
  ver++;
  const pdf = await pdfText(certId);
  assert("PDF: 1 page, A4, the row text is extractable", pdf.task?.status === "completed" && pdf.pages === 1 && Math.abs(pdf.size[0] - 595.28) < 0.35 && rows.slice(0, 3).every((x) => pdf.text.includes(squash(x.name)) && pdf.text.includes(squash(x.amount))), { pages: pdf.pages, size: pdf.size, text: pdf.text.slice(0, 120) });
  r = await api("POST", `/certificates/${certId}/finalize`, A, { expectedVersion: ver });
  assert("no blocking flags → finalize 200", r.status === 200, r.data);

  console.log("\n🧪 Generation — per_invoice, rows from the invoice lines");
  const ph = await uploadTemplate(coA.id, { file: "PHARMAVET_COA.pdf", name: "PHARMAVET collective", certificateTypeId: typeId, scope: "per_invoice" });
  r = await api("POST", `/template-versions/${ph.version.id}/enable-groups`, A);
  await pollTask(r.data?.data?.taskId, A, { timeoutMs: 120_000 });
  const pv2 = await getVersion(r.data.data.versionId);
  const phFields = [
    ...golden["PHARMAVET_COA.pdf"].filter((f) => !f.key.startsWith("constituent") && f.source.kind !== "item" && f.source.kind !== "product").map(({ occurrence, ...f }, i) => ({ ...f, sortOrder: i, ...at(pv2.lines, f.lineId, f.sampleValue, occurrence === "last") })),
    { ...cell(pv2.lines, "name", "p1-l17", "Doxycycline hyclate", { kind: "row", path: "product.name" }), groupKey: "lines" },
    { ...cell(pv2.lines, "amount", "p1-l17", "500 mg", { kind: "row", path: "batchNo" }, true), groupKey: "lines" },
  ];
  r = await api("PUT", `/template-versions/${pv2.id}/fields`, A, { fields: phFields, groups: [group({ kind: "product_list", path: "activeIngredients" }, { key: "lines" })] });
  assert("a product list on a per-invoice template → 422", r.status === 422 && JSON.stringify(r.data).includes("per-product"), r.data);
  r = await api("PUT", `/template-versions/${pv2.id}/fields`, A, { fields: phFields, groups: [group({ kind: "invoice_lines" }, { key: "lines", label: "Products" })] });
  assert("invoice-lines group on PHARMAVET: full table rows, 1 sample row", r.status === 200 && r.data.data.groupDetection.lines?.shape === "table_rows" && r.data.data.groupDetection.lines.sampleRowCount === 1, r.data?.data?.groupDetection || r.data);
  p = await prepareAndActivate(pv2.id);
  assert("PHARMAVET with the group prepares and activates", p.version?.status === "ready" && p.activate?.status === 200, p.version?.prepareReport?.checks?.filter((c) => !c.passed));
  const inv2 = await readyInvoice(coA.id, [
    { data: { name: "ADD-E120", batchNo: "B-1" }, productId: product.id },
    { data: { name: "Doxy", batchNo: "B-2" }, productId: doxy.id },
    { data: { name: "ADD-E120 again", batchNo: "B-3" }, productId: product.id },
  ]);
  g = await generate(inv2.id);
  const collective = g.list.find((c) => c.scope === "per_invoice");
  assert("generate → 3 per-product certificates + 1 collective", g.task?.status === "completed" && g.list.filter((c) => c.scope === "per_product").length === 3 && collective, { task: g.task?.status, err: g.task?.error, scopes: g.list.map((c) => c.scope) });
  const cc = collective && (await getCert(collective.id));
  assert("collective: one row per invoice line, in line order, cells from the line and its matched product", cc?.values?.lines?.rows?.map((x) => `${x.name}/${x.amount}`).join("|") === "ADD-E120/B-1|Doxycycline hyclate/B-2|ADD-E120/B-3", cc?.values?.lines);
  const ccHtml = collective ? await htmlOf(collective.id) : "";
  assert("collective HTML has every line", ["B-1", "B-2", "B-3", "Doxycycline hyclate"].every((t) => ccHtml.includes(t)));
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
