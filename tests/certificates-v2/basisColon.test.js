// QA 27 Nov (re-test): a COC whose product has no composition basis printed a lone ":" under
// "Composition:" — the design's colon after "Each 1 L contains". The real path: a PDF → pdf2htmlEX →
// prepare → the renderer, with the basis empty and filled.
// Needs the stack (cert-renderer) and the pdf2htmlEX container.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeAssert } from "./helpers.js";
import * as pdf2htmlex from "../../src/services/certificates/conversion/pdf2htmlexClient.js";
import * as renderer from "../../src/services/certificates/engine/rendererClient.js";
import { sanitizeTemplateHtml } from "../../src/services/certificates/sanitize/htmlSanitizer.js";
import { runPrepare, renderFilled, fillDef } from "../../src/services/certificates/templates/prepareEngine.js";

const { assert, counts } = makeAssert();
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

try {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText("Composition:", { x: 40, y: 240, size: 11, font });
  page.drawText("Each 1 L contains:", { x: 40, y: 220, size: 11, font });
  page.drawText("Sorbitol 400,000 mg", { x: 40, y: 200, size: 11, font });
  const html = sanitizeTemplateHtml((await pdf2htmlex.convert(Buffer.from(await doc.save()))).html);
  const { lines } = await renderer.analyse(html);
  const line = lines.find((l) => /Each 1 L contains:/.test(l.text));
  assert("the design's basis line is read", !!line, lines.map((l) => l.text));
  const start = line.text.indexOf("Each 1 L contains");
  const field = { key: "composition_basis", label: "Composition basis", lineId: line.id, page: 1, charStart: start, charEnd: start + "Each 1 L contains".length, sampleValue: "Each 1 L contains", required: false, role: "composition_basis", source: { kind: "product", path: "compositionBasis" } };
  const prep = await runPrepare(html, [field]);
  const def = fillDef({ ...field, ...prep.geometry.composition_basis });
  assert("the basis place asks for its colon to go when empty", def.dropColonWhenEmpty === true, def);

  const empty = await renderFilled(prep.preparedHtml, [def], { composition_basis: "" });
  const e = textOf(empty.html);
  assert("an empty basis: no lone colon between «Composition:» and the first ingredient", /Composition:\s*Sorbitol/.test(e) && !/Composition:\s*:/.test(e), e.slice(0, 200));
  const filled = await renderFilled(prep.preparedHtml, [def], { composition_basis: "Each 1 mL contains" });
  const f = textOf(filled.html);
  assert("a basis given: printed with the design's colon", /Each 1 mL contains\s*:/.test(f), f.slice(0, 200));
  const other = fillDef({ ...field, ...prep.geometry.composition_basis, role: null, source: { kind: "manual" }, key: "composition_basis" });
  const kept = textOf((await renderFilled(prep.preparedHtml, [other], { composition_basis: "" })).html);
  assert("any other empty place keeps the design's colon", /Composition:\s*:/.test(kept), kept.slice(0, 200));
} catch (err) {
  assert(`no crash: ${err.message}`, false, err.stack);
}
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
process.exit(counts.failed ? 1 : 0);
