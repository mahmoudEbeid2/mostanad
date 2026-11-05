// Characters the design's subset font lacks: the rules without a browser, then real
// renders (ADDVET's regular font lacks B X j x), the PDF, the API and tenant isolation.
// Needs the pdf2htmlex and cert-renderer services and the API.
import fs from "fs";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { api, asAdmin, asCompany, cleanupCompany, createCompany, fixture, makeAssert, finish, prisma, FIXTURES } from "./helpers.js";
import { putFile } from "../../src/services/certificates/storage/fileStore.js";
import { matchFallback, computeFontFallbacks, cleanFontName } from "../../src/services/certificates/analysis/fontFallbackMatch.js";
import { computeFontCoverage } from "../../src/services/certificates/analysis/fontCoverage.js";
import { FALLBACK_FAMILIES, faceFor, faceName, fallbackFontNames, fieldFontClasses, pickFace, readFontFile } from "../../src/services/certificates/engine/fallbackFonts.js";
import { LOOK_ALIKES } from "../../src/services/certificates/engine/glyphLookAlikes.js";
import { planGlyphs } from "../../src/services/certificates/engine/glyphPlan.js";
import { fallbackFontCss } from "../../src/services/certificates/engine/fallbackFaces.js";
import { isBlocking, countBlocking } from "../../src/services/certificates/generation/batchService.js";
import * as pdf2htmlex from "../../src/services/certificates/conversion/pdf2htmlexClient.js";
import * as renderer from "../../src/services/certificates/engine/rendererClient.js";
import { sanitizeTemplateHtml } from "../../src/services/certificates/sanitize/htmlSanitizer.js";
import { runPrepare, renderFilled, fillDef } from "../../src/services/certificates/templates/prepareEngine.js";

const { assert, counts } = makeAssert();
const NO_FONT_HAS = "\u{13000}"; // an Egyptian hieroglyph

const plan = (value, coverage, entry = { fallbackFamily: "Liberation Sans", weight: 400, style: "normal" }) =>
  planGlyphs({ values: { a: value }, defs: [{ key: "a", fontClass: "ff1" }], fontCoverage: { ff1: coverage }, fontFallbacks: entry ? { ff1: entry } : null });

console.log("\n🧪 Design font name → fallback");
{
  const table = [
    ["ABCDEF+Arial-BoldMT", "Liberation Sans", 700, "normal"],
    ["Helvetica-Oblique", "Liberation Sans", 400, "italic"],
    ["Arimo", "Liberation Sans", 400, "normal"],
    ["TimesNewRomanPS-BoldItalicMT", "Liberation Serif", 700, "italic"],
    ["Times-Roman", "Liberation Serif", 400, "normal"],
    ["CourierNewPSMT", "Liberation Mono", 400, "normal"],
    ["Calibri-Bold", "Carlito", 700, "normal"],
    ["Cambria-Italic", "Caladea", 400, "italic"],
    ["Tahoma", "Noto Sans", 400, "normal"],
    ["Verdana-Bold", "Noto Sans", 700, "normal"],
    ["SegoeUI-Semibold", "Noto Sans", 600, "normal"],
    ["PBVULO+Metropolis-Regular", "Noto Sans", 400, "normal"],
    ["OZKCDQ+Geogrotesque-SemiBold", "Noto Sans", 600, "normal"],
    ["KabelITCbyBT-Book", "Noto Sans", 400, "normal"],
    ["CenturyGothic", "Noto Sans", 400, "normal"],
    ["SourceSerifPro-Regular", "Noto Serif", 400, "normal"],
    ["Georgia-Bold", "Noto Serif", 700, "normal"],
    ["NotoNaskhArabic-Bold", "Noto Sans Arabic", 700, "normal"],
  ];
  for (const [name, family, weight, style] of table) {
    const m = matchFallback(name);
    assert(`${name} → ${family} ${weight} ${style}`, m.fallbackFamily === family && m.weight === weight && m.style === style, m);
  }
  assert("the subset prefix is dropped", cleanFontName("ABCDEF+Arial-BoldMT") === "Arial-BoldMT");
  assert("OS/2 weight when the name says nothing", matchFallback("Foo", { os2Weight: 700 }).weight === 700);
  assert("the italic table when the name says nothing", matchFallback("Foo", { italic: true }).style === "italic");
  assert("Arabic letters win over a Latin name", matchFallback("Arial", { chars: "ابتثجحخ-1" }).fallbackFamily === "Noto Sans Arabic");
  assert("a few Arabic letters in a Latin font don't", matchFallback("Arial", { chars: "abcdefghابت" }).fallbackFamily === "Liberation Sans");
  assert("a serif Panose with an unknown name → Noto Serif", matchFallback("Foo", { panose: [2, 2, 5] }).fallbackFamily === "Noto Serif");
  assert("every family named by the rules is shipped", ["Liberation Sans", "Liberation Serif", "Liberation Mono", "Carlito", "Caladea", "Noto Sans", "Noto Serif", "Noto Sans Arabic", "Noto Sans Symbols 2"].every((f) => FALLBACK_FAMILIES.includes(f)));
  assert("every face's file exists", FALLBACK_FAMILIES.every((f) => readFontFile(pickFace(f).file).length > 1000));
}

console.log("\n🧪 Faces and coverage");
{
  assert("semibold takes the bold face", faceName("Liberation Sans", pickFace("Liberation Sans", 600, "normal")) === "Liberation Sans Bold");
  assert("bold italic", faceName("Noto Serif", pickFace("Noto Serif", 700, "italic")) === "Noto Serif Bold Italic");
  assert("a family with no italic gives its closest face", faceName("Noto Sans Arabic", pickFace("Noto Sans Arabic", 700, "italic")) === "Noto Sans Arabic Bold");
  const entry = { fallbackFamily: "Liberation Sans", weight: 700, style: "normal" };
  assert("the matched font is tried first", faceFor(entry, "+").name === "Liberation Sans Bold");
  assert("a symbol it lacks comes from the chain", faceFor(entry, "\u{1F800}").family === "Noto Sans Symbols 2", faceFor(entry, "\u{1F800}")?.name);
  assert("Arabic comes from the chain", faceFor(entry, "ب").family === "Noto Sans Arabic", faceFor(entry, "ب")?.name);
  assert("a character none has → null", faceFor(entry, NO_FONT_HAS) === null);
  assert("no entry → null", faceFor(undefined, "+") === null);
}

console.log("\n🧪 Plan: fallback, blocking, unknown");
{
  let p = plan("10+5", "0123456789");
  assert('"+" goes to the matched font', p.classes.ff1.fallback["+"] === "Liberation Sans", p);
  assert("characters the design font has stay out of the plan", Object.keys(p.classes.ff1.fallback).join() === "+");
  assert("the design font comes first in the stack", p.classes.ff1.stack === '"ff1", "Liberation Sans", sans-serif', p.classes.ff1.stack);
  assert("the face is subset to the characters used", p.faces.length === 1 && p.faces[0].chars === "+", p.faces);
  assert("a covered value needs no plan, so nothing is added to the document", plan("105", "0123456789") === null);
  assert("a character no font has stays out: the engine flags it", plan(`1${NO_FONT_HAS}`, "0123456789") === null);
  assert("unknown coverage → no plan (glyph_unknown stays)", plan("10+5", null) === null);
  assert("not matched yet → no fallback (glyph: stays)", plan("10+5", "0123456789", null) === null);
  const groups = [{ key: "g", cells: [{ key: "c", fontClass: "ff2" }] }];
  p = planGlyphs({ values: { g: [{ c: "+" }] }, defs: [], groups, fontCoverage: { ff2: "1" }, fontFallbacks: { ff2: { fallbackFamily: "Noto Sans", weight: 400, style: "normal" } } });
  assert("group cells are planned too", p.classes.ff2.fallback["+"] === "Noto Sans", p);
  p = planGlyphs({ values: { g: [] }, defs: [], groups, fontCoverage: { ff2: "-" }, fontFallbacks: null });
  assert('the "—" of an empty group is planned', p.classes.ff2.subs["—"] === "-", p);
  const css = await fallbackFontCss([{ name: "Noto Sans", file: pickFace("Noto Sans").file, chars: "+" }]);
  assert("embedded as data:, not a file", /^@font-face\{font-family:"Noto Sans";src:url\(data:font\/ttf;base64,/.test(css));
  assert(`the subset is small (${css.length} B vs ${readFontFile(pickFace("Noto Sans").file).length} B)`, css.length < 20_000, css.length);
}

console.log("\n🧪 Look-alikes");
{
  const pairs = [[" ", " "], ["‘", "'"], ["’", "'"], ["“", '"'], ["”", '"'], ["–", "-"], ["—", "-"], ["µ", "μ"], ["μ", "µ"]];
  assert("the list is exactly the agreed pairs", Object.keys(LOOK_ALIKES).length === pairs.length && pairs.every(([a, b]) => LOOK_ALIKES[a]?.join() === b), Object.keys(LOOK_ALIKES));
  for (const [from, to] of pairs) {
    const p = plan(`1${from}2`, `12${to}`);
    assert(`U+${from.codePointAt(0).toString(16)} → U+${to.codePointAt(0).toString(16)} when the font lacks it`, p?.classes.ff1.subs[from] === to, p);
    assert(`U+${from.codePointAt(0).toString(16)} kept when the font has it`, plan(`1${from}2`, `12${from}${to}`) === null);
  }
  assert("no swap when the font lacks the equivalent too: the fallback draws it", plan("1–2", "12").classes.ff1.fallback["–"] === "Liberation Sans");
  for (const ch of ["+", "−", "±", "×", "x", "°", "º", "0", "9", "%", "L", "l", "I", "1"]) {
    const others = "x-'\" 0123456789+−±×°º%LlI".replace(ch, "");
    const p = plan(ch, others);
    assert(`never swapped: ${ch}`, !p || !Object.keys(p.classes.ff1?.subs || {}).length, p);
  }
}

console.log("\n🧪 Flags");
{
  assert("glyph_fallback doesn't block", !isBlocking("glyph_fallback:+"));
  assert("glyph: blocks", isBlocking("glyph:+"));
  assert("glyph_unknown doesn't block", !isBlocking("glyph_unknown"));
  assert("the issue count ignores glyph_fallback", countBlocking({ a: { flags: ["glyph_fallback:+"] }, b: { flags: ["glyph:+"] } }) === 1);
  const entry = { fallbackFamily: "Liberation Sans", weight: 700, style: "normal" };
  const names = fallbackFontNames({ a: ["shrunk", "glyph_fallback:+"], g: ["glyph_fallback:+"], c: ["glyph:+"] }, fieldFontClasses([{ key: "a", fontClass: "ff1" }, { key: "x", groupKey: "g", fontClass: "ff1" }]), { ff1: entry });
  assert("the font that drew each character is named, a group's too", names.a["+"] === "Liberation Sans Bold" && names.g["+"] === "Liberation Sans Bold" && !names.c, names);
}

const fontsInPdf = async (buffer) => {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const fonts = content.styles;
  return { text: content.items.map((i) => i.str).join(""), items: content.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, font: i.fontName, family: fonts[i.fontName]?.fontFamily })) };
};

let company = null;
let other = null;
try {
  console.log("\n🧪 A real render (ADDVET, regular font lacks B X j x)");
  const html = sanitizeTemplateHtml((await pdf2htmlex.convert(fixture("ADDVET_COA.ai"))).html);
  const coverage = computeFontCoverage(html);
  const fallbacks = computeFontFallbacks(html);
  assert("each embedded font has a match with its PDF name", Object.keys(coverage).every((k) => fallbacks[k]?.pdfName && FALLBACK_FAMILIES.includes(fallbacks[k].fallbackFamily)), fallbacks);
  const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"))["ADDVET_COA.ai"].filter((g) => g.key === "batch_no");
  const { lines } = await renderer.analyse(html);
  const fields = golden.map((g) => {
    const text = lines.find((l) => l.id === g.lineId)?.text || "";
    const start = text.indexOf(g.sampleValue);
    return { ...g, page: 1, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  const plain = await runPrepare(html, fields, { fontCoverage: coverage });
  const withFallbacks = await runPrepare(html, fields, { fontCoverage: coverage, fontFallbacks: fallbacks });
  assert("the prepare gate passes with fallbacks", withFallbacks.report.passed, withFallbacks.report.checks);
  assert("the gate's pixel diff is the same with and without fallbacks", withFallbacks.report.pixelDiffPct === plain.report.pixelDiffPct, [plain.report.pixelDiffPct, withFallbacks.report.pixelDiffPct]);
  assert("the prepared HTML is the same with and without fallbacks", withFallbacks.preparedHtml === plain.preparedHtml);
  assert("nothing about fallbacks is stored in the template", !/data-font-fallback/.test(withFallbacks.preparedHtml));
  const def = fillDef({ ...fields[0], ...withFallbacks.geometry.batch_no });
  const opts = { fontCoverage: coverage, fontFallbacks: fallbacks };

  const covered = await renderFilled(withFallbacks.preparedHtml, [def], { batch_no: "AVVS1124011" }, opts);
  assert("a covered value: no flag, no font added, no inline font", !covered.flags.batch_no.length && !/data-font-fallback/.test(covered.html) && !/style="[^"]*font-family/.test(covered.html.split('data-field="batch_no"')[1]?.slice(0, 200) || ""));

  const values = { batch_no: "AVBX+1124" };
  const out = await renderFilled(withFallbacks.preparedHtml, [def], values, opts);
  assert("missing characters → glyph_fallback, not glyph", out.flags.batch_no.includes("glyph_fallback:BX"), out.flags.batch_no);
  assert("nothing blocking", !out.flags.batch_no.some(isBlocking), out.flags.batch_no);
  assert("the value object is not changed", values.batch_no === "AVBX+1124");
  assert("the design's fonts stay embedded, the fallback faces join them", /data-font-fallback/.test(out.html) && /font-family:\s*ff1/.test(out.html));
  assert(`the fallback adds little to the document (${out.html.length - covered.html.length} B)`, out.html.length - covered.html.length < 60_000);

  const { pdf } = await renderer.printPdf(out.html);
  const read = await fontsInPdf(pdf);
  assert("the PDF has the value as real text", read.text.includes("AVBX+1124"), read.text.slice(0, 200));
  const runs = read.items.filter((i) => /^[AVBX+1124]+$/.test(i.str) && "AVBX+1124".includes(i.str));
  assert("the line uses two fonts in the PDF", new Set(runs.map((r) => r.font)).size >= 2, runs);
  const fallbackRun = runs.find((r) => r.str === "BX");
  const designRuns = runs.filter((r) => r.str === "AV" || r.str === "+1124");
  assert("only the missing characters are in another font: the rest of the line stays in the design font", fallbackRun && designRuns.length >= 2 && designRuns[0].font === runs[runs.indexOf(designRuns[0]) + 2]?.font && designRuns.every((r) => r.font !== fallbackRun.font), runs);

  const dash = await renderFilled(withFallbacks.preparedHtml, [def], { batch_no: "AV 1124" }, opts);
  assert("a look-alike renders as its equivalent and raises no flag", !dash.flags.batch_no.length && dash.html.includes("AV 1124") && !dash.html.includes("AV 1124"), dash.flags.batch_no);

  const none = await renderFilled(withFallbacks.preparedHtml, [def], { batch_no: `A${NO_FONT_HAS}` }, opts);
  assert("a character no font has → blocking glyph", none.flags.batch_no.includes(`glyph:${NO_FONT_HAS}`) && none.flags.batch_no.some(isBlocking), none.flags.batch_no);

  const both = await renderFilled(withFallbacks.preparedHtml, [def], { batch_no: `B${NO_FONT_HAS}` }, opts);
  assert("both in one value → both flags", both.flags.batch_no.includes(`glyph:${NO_FONT_HAS}`) && both.flags.batch_no.includes("glyph_fallback:B"), both.flags.batch_no);

  const old = await renderFilled(withFallbacks.preparedHtml, [def], { batch_no: "B" }, { fontCoverage: coverage });
  assert("a version not matched yet behaves as before", old.flags.batch_no.includes("glyph:B") && !/data-font-fallback/.test(old.html), old.flags.batch_no);

  console.log("\n🧪 API: font matches, owner override, tenants");
  company = await createCompany("glyph_a");
  other = await createCompany("glyph_b");
  const type = await prisma.certificateType.create({ data: { companyId: company.id, name: "Glyph COA", code: `G${Date.now() % 100000}` } });
  const src = await putFile({ companyId: company.id, kind: "template_source", buffer: Buffer.from("<p>x</p>"), mimeType: "text/html", ext: "html" });
  const template = await prisma.certificateTemplate.create({ data: { companyId: company.id, certificateTypeId: type.id, name: "Glyph" } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, versionNumber: 1, status: "draft", sourceFormat: "html", sourceFileId: src.id, fontFallbacks: fallbacks } });
  const url = `/template-versions/${version.id}`;
  const A = asCompany(company.id);
  let r = await api("GET", url, A);
  assert("the version lists each design font with its match", r.data?.data?.version?.fontMatches?.length === Object.keys(fallbacks).length && r.data.data.version.fontMatches[0].fontClass === "ff1" && r.data.data.version.fontMatches[0].fallbackName, r.data?.data?.version?.fontMatches);
  assert("and the shipped fonts to choose from", r.data?.data?.version?.fallbackFontFamilies?.includes("Liberation Sans"));
  r = await api("PATCH", `${url}/font-fallbacks`, A, { fontClass: "ff1", fallbackFamily: "Caladea" });
  assert("the owner can change a match", r.status === 200 && r.data.data.fontMatches[0].fallbackFamily === "Caladea" && r.data.data.fontMatches[0].source === "owner", r.data);
  const saved = await prisma.templateVersion.findUnique({ where: { id: version.id } });
  assert("stored, weight and style kept", saved.fontFallbacks.ff1.fallbackFamily === "Caladea" && saved.fontFallbacks.ff1.weight === fallbacks.ff1.weight);
  r = await api("PATCH", `${url}/font-fallbacks`, A, { fontClass: "ff1", fallbackFamily: "Comic Sans" });
  assert("a font that isn't shipped → 422", r.status === 422 && r.data?.code === "INVALID_FONT", r.data);
  r = await api("PATCH", `${url}/font-fallbacks`, A, { fontClass: "ff99", fallbackFamily: "Caladea" });
  assert("a font the version lacks → 422", r.status === 422 && r.data?.code === "UNKNOWN_FONT", r.data);
  r = await api("PATCH", `${url}/font-fallbacks`, asCompany(other.id), { fontClass: "ff1", fallbackFamily: "Carlito" });
  assert("another company → 404", r.status === 404, r.status);
  r = await api("GET", url, asCompany(other.id));
  assert("another company can't read it → 404", r.status === 404, r.status);
  await prisma.templateVersion.update({ where: { id: version.id }, data: { status: "active" } });
  r = await api("PATCH", `${url}/font-fallbacks`, A, { fontClass: "ff1", fallbackFamily: "Carlito" });
  assert("an active version can't change → 409", r.status === 409 && r.data?.code === "VERSION_NOT_DRAFT", r.data);
  r = await api("PATCH", `${url}/font-fallbacks?companyId=${company.id}`, asAdmin, { fontClass: "ff1", fallbackFamily: "Carlito" });
  assert("nor through a system user", r.status === 409, r.status);
} catch (err) {
  console.error(err);
  counts.failed++;
} finally {
  await finish(counts, async () => {
    for (const c of [company, other]) if (c) await cleanupCompany(c.id);
  });
}
