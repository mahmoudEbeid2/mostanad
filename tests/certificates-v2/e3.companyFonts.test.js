// Client report 24 Nov, item 7: the "Design fonts" panel matched Axiforma,
// Microgramma and MyriadPro all to Noto Sans. A company uploads its own fonts
// (.ttf/.otf/.woff2); they appear in those selects, are suggested for the design
// fonts of the same family (set on draft versions), and a character the design's
// subset lacks is drawn from them in the preview / certificate (the renderer gets
// the bytes with the render). Needs `npm run dev:test` (cert-renderer + workers).
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, form, prisma } from "./helpers.js";
import { readFont, suggestCompanyFont, withCompanySuggestions, coverageRanges } from "../../src/services/certificates/fonts/companyFontService.js";
import { fallbackFaces } from "../../src/services/certificates/engine/fallbackFonts.js";
import { planGlyphs } from "../../src/services/certificates/engine/glyphPlan.js";

const { assert, counts } = makeAssert();
const FONT_DIR = path.join(process.cwd(), "assets", "cert-fonts");
const serif = fs.readFileSync(path.join(FONT_DIR, "LiberationSerif-Regular.ttf"));
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const co = await createCompany("e3");
const A = asCompany(co.id);

try {
  console.log("Reading a font file");
  const info = readFont(serif, "LiberationSerif-Regular.ttf");
  assert("family, face name, weight, style and coverage from the file", info.family === "Liberation Serif" && /Liberation Serif/.test(info.name) && info.weight === 400 && info.style === "normal" && info.format === "ttf" && info.coverage.length > 5, { ...info, coverage: info.coverage.length });
  let err = (() => { try { readFont(fs.readFileSync(path.join(FIXTURES, "PHARMAVET_COA.pdf")), "x.pdf"); } catch (e) { return e; } })();
  assert("a file that isn't a font → refused", err?.code === "INVALID_FONT_FILE", err?.message);
  assert("coverage ranges merge neighbours", JSON.stringify(coverageRanges([65, 66, 67, 70, 69])) === "[[65,67],[69,70]]");

  console.log("\nSuggestions");
  const fonts = [{ id: "1", family: "Axiforma", name: "Axiforma Book", weight: 400, style: "normal" }, { id: "2", family: "Axiforma", name: "Axiforma SemiBold", weight: 600, style: "normal" }];
  assert("a design font of the same family → that face (nearest weight)", suggestCompanyFont(fonts, { pdfName: "ABCDEF+Axiforma-SemiBold", weight: 600 })?.id === "2" && suggestCompanyFont(fonts, { pdfName: "Axiforma-Book", weight: 400 })?.id === "1");
  assert("another family → no suggestion (the shipped match stays)", suggestCompanyFont(fonts, { pdfName: "Microgramma-Bold", weight: 700 }) === null);
  const sug = withCompanySuggestions({ f1: { pdfName: "Axiforma-Book", fallbackFamily: "Noto Sans", weight: 400, style: "normal", source: "auto" }, f2: { pdfName: "Axiforma-Bold", fallbackFamily: "Liberation Sans", weight: 700, style: "normal", source: "owner" } }, fonts.map((f) => ({ ...f, coverage: [[65, 90]] })));
  assert("automatic matches take the company font; a person's own choice is kept", sug.changed === 1 && sug.fontFallbacks.f1.company?.id === "1" && sug.fontFallbacks.f1.source === "company_auto" && !sug.fontFallbacks.f2.company);

  console.log("\nThe engine");
  const entry = { fallbackFamily: "Noto Sans", weight: 400, style: "normal", company: { id: "cf1", name: "Axiforma Book", coverage: [[0x0400, 0x04ff]] } };
  const faces = fallbackFaces(entry);
  assert("the company font is tried first, the shipped match after it", faces[0].name === "Axiforma Book" && faces[0].face.file === "company:cf1" && faces[1].family === "Noto Sans");
  const plan = planGlyphs({ values: { k: "abЖ" }, defs: [{ key: "k", fontClass: "f1" }], fontCoverage: { f1: "ab" }, fontFallbacks: { f1: entry } });
  assert("a character the design lacks and the company font has → drawn from it", plan?.classes?.f1?.fallback?.["Ж"] === "Axiforma Book" && plan.faces[0].file === "company:cf1", plan);

  console.log("\nUpload, select, render (real API + renderer)");
  const type = await prisma.certificateType.create({ data: { companyId: co.id, code: "COA", name: "Certificate of Analysis" } });
  const up = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name: "Fonts COA", certificateTypeId: type.id });
  const v = up.version;
  const fields = golden["PHARMAVET_COA.pdf"].map((g) => {
    const text = v.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const prep = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  assert("the template is prepared (setup)", prep?.status === "completed", prep?.error);

  r = await api("POST", "/certificate-fonts", A, form({}, { buffer: serif, name: "LiberationSerif-Regular.ttf", type: "font/ttf" }));
  const font = r.data?.data?.font;
  assert("POST /certificate-fonts → the font, as the company's", r.status === 201 && font?.family === "Liberation Serif" && (await prisma.companyFont.count({ where: { companyId: co.id } })) === 1, r.data);
  r = await api("POST", "/certificate-fonts", A, form({}, { buffer: Buffer.from("not a font at all, just text"), name: "x.ttf", type: "font/ttf" }));
  assert("a file that isn't a font → 400", r.status === 400, r.data);
  r = await api("GET", "/certificate-fonts", A);
  assert("GET /certificate-fonts lists it", r.status === 200 && r.data.data.fonts.some((f) => f.id === font.id));

  r = await api("GET", `/template-versions/${v.id}`, A);
  const detail = r.data?.data?.version || r.data?.data;
  assert("the version detail offers the company's fonts for the selects", detail?.companyFonts?.some((f) => f.id === font.id), detail?.companyFonts);
  const classes = Object.keys(detail.fontFallbacks || {});
  for (const fontClass of classes) {
    r = await api("PATCH", `/template-versions/${v.id}/font-fallbacks`, A, { fontClass, companyFontId: font.id });
    if (r.status !== 200) break;
  }
  const match = r.data?.data?.fontMatches?.[0];
  assert("choosing it for a design font → the match names the company font", r.status === 200 && match?.companyFontId === font.id && match.fallbackName === font.name, r.data);
  r = await api("PATCH", `/template-versions/${v.id}/font-fallbacks`, A, { fontClass: classes[0] });
  assert("neither a shipped font nor a company font → 400", r.status === 400, r.status);

  const batchKey = golden["PHARMAVET_COA.pdf"].find((g) => g.key === "batch_no").key;
  r = await api("POST", `/template-versions/${v.id}/preview`, A, { values: { [batchKey]: "ЖБ-2026" } });
  const drawn = r.data?.data?.fallbackFonts?.[batchKey] || {};
  assert("preview: characters the design lacks are drawn from the uploaded font", r.status === 200 && drawn["Ж"] === font.name && drawn["Б"] === font.name, { status: r.status, drawn, flags: r.data?.data?.flags?.[batchKey] });
  assert("…and its glyphs are embedded in the page (subset, data: URL)", new RegExp(`@font-face\\{font-family:"${font.name}";src:url\\(data:font/ttf;base64,`).test(r.data?.data?.html || ""));

  console.log("\nUploading a font sets it on draft versions of the same family");
  const other = await prisma.templateVersion.findUnique({ where: { id: v.id } });
  await prisma.templateVersion.update({ where: { id: v.id }, data: { fontFallbacks: Object.fromEntries(Object.entries(other.fontFallbacks).map(([k, e]) => { const { company, ...rest } = e; return [k, { ...rest, pdfName: "ABCDEF+LiberationSerif", source: "auto" }]; })) } });
  r = await api("POST", "/certificate-fonts", A, form({}, { buffer: serif, name: "LiberationSerif-Regular.ttf", type: "font/ttf" }));
  const after = await prisma.templateVersion.findUnique({ where: { id: v.id } });
  assert("the same face again replaces it; draft versions whose design font is that family now use it", r.status === 201 && r.data.data.appliedTo >= 1 && Object.values(after.fontFallbacks).every((e) => e.company?.id === font.id && e.source === "company_auto") && (await prisma.companyFont.count({ where: { companyId: co.id } })) === 1, r.data);
} catch (err) {
  assert(`crashed: ${err.message}`, false, err.stack);
} finally {
  await cleanupCompany(co.id).catch((e) => console.error(e.message));
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
