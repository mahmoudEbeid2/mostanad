// Certificates V2 Phase 1 — Foundations (CERTIFICATES_V2_PLAN.md §17 row 1).
// Exit criteria proven here:
//  - both goldens upload → convert → `draft`, and the stored sanitized preview
//    is pixel-identical to pdf2htmlEX's raw output (0 differing pixels)
//  - malicious HTML is neutralised (stored file + HTML endpoint headers)
//  - NO_PDF_CONTENT / NO_LIVE_TEXT fail explicitly
//  - types CRUD, slot uniqueness, new version, tenancy (404) on every resource
// Needs the guarded stack (npm run dev:test) and the pdf2htmlex service.
import {
  api, asCompany, asAdmin, form, fixture, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, pollTask,
} from "./helpers.js";
import * as pdf2htmlex from "../../src/services/certificates/conversion/pdf2htmlexClient.js";
import * as renderer from "../../src/services/certificates/engine/renderer.js";
import { comparePngs } from "../../src/services/certificates/engine/pixelDiff.js";

const { assert, counts } = makeAssert();
const coA = await createCompany("p1a");
const coB = await createCompany("p1b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

try {
  console.log("\n🧪 Converter reachable");
  const h = await pdf2htmlex.health();
  assert("pdf2htmlex /health ok", h.ok, h);

  console.log("\n🧪 Certificate types");
  let r = await api("POST", "/certificate-types", A, { name: "Certificate of Analysis", code: "coa" });
  assert("create type → 201", r.status === 201, r.data);
  const coaType = r.data?.data?.type;
  assert("code normalised to upper case", coaType?.code === "COA", coaType);
  r = await api("POST", "/certificate-types", A, { name: "Duplicate", code: "COA" });
  assert("duplicate code → 409 TYPE_CODE_TAKEN", r.status === 409 && r.data?.code === "TYPE_CODE_TAKEN", r.data);
  r = await api("POST", "/certificate-types", A, { name: "x", code: "bad code!" });
  assert("invalid body → 400", r.status === 400, r.status);
  r = await api("POST", "/certificate-types", A, { name: "Free Sale Certificate", code: "FSC" });
  const fscType = r.data?.data?.type;
  r = await api("GET", "/certificate-types", A);
  assert("list shows own types", r.status === 200 && r.data.data.types.length === 2, r.data);
  r = await api("GET", "/certificate-types", B);
  assert("other tenant sees none", r.status === 200 && r.data.data.types.length === 0, r.data);
  r = await api("PATCH", `/certificate-types/${coaType.id}`, B, { name: "hijack" });
  assert("PATCH another tenant's type → 404", r.status === 404, r.status);
  r = await api("DELETE", `/certificate-types/${fscType.id}`, B);
  assert("DELETE another tenant's type → 404", r.status === 404, r.status);
  r = await api("GET", "/certificate-types", asAdmin);
  assert("system user without companyId → 400", r.status === 400, r.status);
  r = await api("GET", `/certificate-types?companyId=${coA.id}`, asAdmin);
  assert("system user with ?companyId= → 200", r.status === 200 && r.data.data.types.length === 2, r.status);

  console.log("\n🧪 Upload validation (synchronous)");
  r = await api("POST", "/certificate-templates", A, form({ name: "No PDF", certificateTypeId: coaType.id }, { buffer: fixture("no_pdf_content.ai"), name: "no_pdf_content.ai" }));
  assert("no_pdf_content.ai → 422 NO_PDF_CONTENT", r.status === 422 && r.data?.code === "NO_PDF_CONTENT", r.data);
  assert("… message tells the user what to do", /Create PDF Compatible File/.test(r.data?.message || ""), r.data?.message);
  r = await api("POST", "/certificate-templates", A, form({ name: "Word file", certificateTypeId: coaType.id }, { buffer: Buffer.from("x"), name: "design.docx" }));
  assert("unsupported extension → 400 UNSUPPORTED_FORMAT", r.status === 400 && r.data?.code === "UNSUPPORTED_FORMAT", r.data);
  r = await api("POST", "/certificate-templates", B, form({ name: "Foreign type", certificateTypeId: coaType.id }, { buffer: fixture("PHARMAVET_COA.pdf"), name: "x.pdf" }));
  assert("another tenant's certificate type → 404", r.status === 404, r.data);

  console.log("\n🧪 Goldens: upload → convert → draft, pixel-identical preview");
  const goldens = {};
  // ADDVET → FSC slot; PHARMAVET → the country-specific (TR) COA slot.
  for (const [file, typeId, country, expectLines] of [
    ["ADDVET_COA.ai", fscType.id, null, 33],
    ["PHARMAVET_COA.pdf", coaType.id, "TR", 27],
  ]) {
    const up = await uploadTemplate(coA.id, { file, name: file, certificateTypeId: typeId, country });
    assert(`${file}: 202 accepted with ids`, up.status === 202 && up.data?.data?.templateId && up.data?.data?.taskId, up.data);
    assert(`${file}: convert task completed`, up.task?.status === "completed", up.task?.error);
    const v = up.version;
    goldens[file] = { up, v };
    assert(`${file}: version is draft`, v?.status === "draft", v?.status);
    assert(`${file}: ${expectLines} lines with ids`, v?.lines?.length === expectLines && v.lines.every((l) => /^p1-l\d+$/.test(l.id)), v?.lines?.length);
    assert(`${file}: 1 page 793.69×1122.52 px = 595.27×841.89 pt`, v?.pages?.length === 1 && Math.abs(v.pages[0].widthPx - 793.688) < 0.01 && Math.abs(v.pages[0].widthPt - 595.27) < 0.02 && Math.abs(v.pages[0].heightPt - 841.89) < 0.02, v?.pages);
    assert(`${file}: conversion metadata (pdf2htmlEX, zoom 4/3)`, v?.conversion?.tool === "pdf2htmlEX" && Math.abs(v.conversion.zoom - 4 / 3) < 1e-6, v?.conversion);

    const html = await api("GET", `/template-versions/${v.id}/html?variant=sanitized`, A);
    assert(`${file}: HTML 200 text/html`, html.status === 200 && /text\/html/.test(html.headers.get("content-type")), html.status);
    assert(`${file}: CSP default-src 'none'`, /default-src 'none'/.test(html.headers.get("content-security-policy") || ""), html.headers.get("content-security-policy"));
    assert(`${file}: X-Content-Type-Options nosniff`, html.headers.get("x-content-type-options") === "nosniff");
    const stored = html.buffer.toString("utf8");
    assert(`${file}: stored HTML has no <script>`, !/<script/i.test(stored));

    const raw = (await pdf2htmlex.convert(fixture(file))).html;
    const [rawShot] = await renderer.screenshotPages(raw);
    const [cleanShot] = await renderer.screenshotPages(stored);
    const diff = await comparePngs(rawShot.png, cleanShot.png);
    console.log(`     ${file}: raw vs stored preview → ${diff.diffPixels} px differ (${diff.pct.toFixed(4)} %)`);
    assert(`${file}: preview pixel-identical to the converted design`, diff.diffPixels === 0 && !diff.sizeMismatch, diff.pct);

    const thumb = await api("GET", `/template-versions/${v.id}/thumbnail`, A);
    assert(`${file}: thumbnail is a PNG`, thumb.status === 200 && thumb.buffer?.subarray(1, 4).toString() === "PNG", thumb.status);
  }
  const addvet = goldens["ADDVET_COA.ai"].v;
  assert("ADDVET: Batch No. line is p1-l11 (plan §12.1)", addvet.lines.find((l) => l.id === "p1-l11")?.text === "Batch No.:  AVVS1122005");
  assert("ADDVET: regular font ff1 lacks B X j x (plan §3.2)", ["B", "X", "j", "x"].every((c) => !addvet.fontCoverage.ff1.includes(c)), addvet.fontCoverage?.ff1);
  assert("ADDVET: bold font ff2 has no digits 0/1/9", ["0", "1", "9"].every((c) => !addvet.fontCoverage.ff2.includes(c)));
  const pharma = goldens["PHARMAVET_COA.pdf"].v;
  assert("PHARMAVET: Turkish producer line present", pharma.lines.some((l) => l.text.includes("PHARMAVET İÇ VE DIŞ TİCARET")));

  console.log("\n🧪 Explicit conversion failures");
  r = await uploadTemplate(coA.id, { file: "outlined_text.pdf", name: "Outlined", certificateTypeId: coaType.id, country: "EG" });
  assert("outlined text → task failed NO_LIVE_TEXT", r.task?.status === "failed" && /NO_LIVE_TEXT/.test(r.task?.error || ""), r.task?.error);
  assert("outlined text → version failed with reason", r.version?.status === "failed" && /outlines/.test(r.version?.error || ""), r.version?.error);

  console.log("\n🧪 Malicious .html upload is neutralised");
  r = await uploadTemplate(coA.id, { file: "malicious.html", name: "Malicious", certificateTypeId: coaType.id, country: "SA" });
  assert("malicious.html → draft (generic HTML: body = page 1)", r.version?.status === "draft" && r.version?.pages?.length === 1, r.task?.error || r.version?.status);
  assert("generic HTML lines found", r.version?.lines?.some((l) => l.text.includes("Batch No.: AVVS1122005")), r.version?.lines?.map((l) => l.text));
  const mal = await api("GET", `/template-versions/${r.version.id}/html`, A);
  const malHtml = mal.buffer.toString("utf8").toLowerCase();
  assert("stored malicious HTML: no script/iframe/form/on*/javascript:/remote URL",
    !/<script|<iframe|<form|<object|<embed|<base|javascript:|evil\.example/.test(malHtml) && !/<[^>]*\son[a-z]+\s*=/.test(malHtml));

  console.log("\n🧪 Slot uniqueness and new versions");
  const pharmaTpl = goldens["PHARMAVET_COA.pdf"].up.data.data.templateId;
  r = await api("POST", "/certificate-templates", A, form({ name: "Clash", certificateTypeId: coaType.id, country: "TR" }, { buffer: fixture("PHARMAVET_COA.pdf"), name: "p.pdf" }));
  assert("same slot → 409 TEMPLATE_SLOT_TAKEN + existingTemplateId", r.status === 409 && r.data?.code === "TEMPLATE_SLOT_TAKEN" && r.data?.existingTemplateId === pharmaTpl, r.data);
  r = await api("POST", `/certificate-templates/${pharmaTpl}/versions`, A, form({}, { buffer: fixture("PHARMAVET_COA.pdf"), name: "p.pdf" }));
  assert("new design version → 202", r.status === 202, r.data);
  const v2Task = await pollTask(r.data.data.taskId, A);
  assert("v2 converted", v2Task?.status === "completed", v2Task?.error);
  r = await api("GET", `/certificate-templates/${pharmaTpl}`, A);
  assert("template lists v2 and v1", r.data?.data?.template?.versions?.map((v) => v.versionNumber).join(",") === "2,1", r.data?.data?.template?.versions);
  r = await api("PATCH", `/certificate-templates/${pharmaTpl}`, A, { country: "" });
  assert("PATCH settings into a free slot → 200", r.status === 200 && r.data.data.template.country === null, r.data);
  r = await api("PATCH", `/certificate-templates/${pharmaTpl}`, A, { country: "TR" });
  assert("PATCH back → 200", r.status === 200, r.data);
  r = await api("PATCH", `/certificate-templates/${pharmaTpl}`, A, { name: "PHARMAVET COA renamed" });
  assert("PATCH name only keeps country (absent key = unchanged)", r.status === 200 && r.data.data.template.country === "TR" && r.data.data.template.name === "PHARMAVET COA renamed", r.data?.data?.template);

  console.log("\n🧪 Lists and filters");
  r = await api("GET", "/certificate-templates", A);
  assert("list: 4 templates (2 goldens, outlined, malicious)", r.status === 200 && r.data.total === 4, r.data?.total);
  r = await api("GET", `/certificate-templates?certificateTypeId=${fscType.id}`, A);
  assert("filter by type", r.data?.total === 1 && r.data.data.templates[0].name === "ADDVET_COA.ai", r.data?.total);
  r = await api("GET", "/certificate-templates?country=tr", A);
  assert("filter by country (case-insensitive)", r.data?.total === 1, r.data?.total);
  r = await api("GET", "/certificate-templates?status=failed", A);
  assert("filter by version status", r.data?.total === 1 && r.data.data.templates[0].name === "Outlined", r.data?.total);

  console.log("\n🧪 Tenancy: every resource is 404 to another company");
  const tplId = goldens["ADDVET_COA.ai"].up.data.data.templateId;
  const verId = addvet.id;
  for (const [label, method, url, body] of [
    ["GET template", "GET", `/certificate-templates/${tplId}`],
    ["PATCH template", "PATCH", `/certificate-templates/${tplId}`, { name: "hijack" }],
    ["archive template", "POST", `/certificate-templates/${tplId}/archive`],
    ["GET version", "GET", `/template-versions/${verId}`],
    ["GET version html", "GET", `/template-versions/${verId}/html`],
    ["GET thumbnail", "GET", `/template-versions/${verId}/thumbnail`],
  ]) {
    r = await api(method, url, B, body);
    assert(`${label} → 404`, r.status === 404, r.status);
  }
  r = await api("POST", `/certificate-templates/${tplId}/versions`, B, form({}, { buffer: fixture("PHARMAVET_COA.pdf"), name: "p.pdf" }));
  assert("upload version into another tenant's template → 404", r.status === 404, r.status);
  r = await api("GET", "/certificate-templates", B);
  assert("other tenant's list is empty", r.data?.total === 0, r.data?.total);
  r = await api("GET", `/background-tasks/${goldens["ADDVET_COA.ai"].up.data.data.taskId}`, B);
  assert("other tenant cannot read the convert task", r.status === 404, r.status);

  console.log("\n🧪 Archive and type deletion rules");
  r = await api("DELETE", `/certificate-types/${fscType.id}`, A);
  assert("delete a used type → 409 TYPE_IN_USE", r.status === 409 && r.data?.code === "TYPE_IN_USE", r.data);
  r = await api("POST", `/certificate-templates/${tplId}/archive`, A);
  assert("archive → archivedAt set", r.status === 200 && !!r.data?.data?.template?.archivedAt, r.data);
  r = await api("POST", "/certificate-types", A, { name: "Unused", code: "UNUSED" });
  r = await api("DELETE", `/certificate-types/${r.data.data.type.id}`, A);
  assert("delete an unused type → 204", r.status === 204, r.status);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await renderer.shutdown();
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
