// Certificates V2 §16.2 — golden field sets through the real field engine
// (in-process renderer, no API). For ADDVET and PHARMAVET:
//  - the prepare gate passes (calibration ≤ 0.5 px, round-trip ≤ 0.5 px,
//    page pixel diff ≤ 0.05 %)
//  - anchoring: longer / shorter values keep every neighbour within 0.5 px,
//    a center-anchored value keeps its center within 0.5 px
//  - overflow: a 3× value → shrunk/overflow, neighbours unmoved
//  - glyph: B/X on ADDVET's regular font → glyph:BX
//  - inspect suggests `center` exactly for PHARMAVET's centered cells
// Needs the pdf2htmlex service.
import fs from "fs";
import path from "path";
import { fixture, makeAssert, finish, FIXTURES } from "./helpers.js";
import * as pdf2htmlex from "../../src/services/certificates/conversion/pdf2htmlexClient.js";
import { sanitizeTemplateHtml } from "../../src/services/certificates/sanitize/htmlSanitizer.js";
import * as renderer from "../../src/services/certificates/engine/renderer.js";
import { computeFontCoverage } from "../../src/services/certificates/analysis/fontCoverage.js";
import { runPrepare, renderFilled, fillDef, GATE } from "../../src/services/certificates/templates/prepareEngine.js";

const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));

const LONGER = { batch_no: "AVVS1124011-77", product_name: "ADD-E120 FORTE", expiry: "06/2027", production: "06/2024", ph_result: "4.25", constituent_2_name: "Sodium selenite pentahydrate", constituent_2_amount: "75 mg", document_no: "COAAVVS1124011", producer: "PHARMAVET İÇ VE DIŞ TİCARET LTD.ŞTİ İSTANBUL", constituent_amount: "1000 mg" };
const SHORTER = { batch_no: "AV1", product_name: "ADD", expiry: "1/27", production: "1/24", ph_result: "4", constituent_2_name: "Se", constituent_2_amount: "6 mg", document_no: "COA1", producer: "PHARMAVET", constituent_amount: "5 mg" };

async function resolveFields(name, html) {
  const { lines } = await renderer.analyse(html);
  return golden[name].map((g) => {
    const text = lines.find((l) => l.id === g.lineId)?.text || "";
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    return { ...g, page: 1, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
}

// positions of all text outside fields, after filling `values`
async function neighbours(preparedHtml, defs, values, coverage) {
  const { html, flags, geometry } = await renderFilled(preparedHtml, defs, values, { fontCoverage: coverage });
  const runs = await renderer.withDocument(html, (page) => renderer.engine(page, "runPositions", true));
  return { runs, flags, geometry };
}

const maxDrift = (a, b) => {
  let worst = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
  return { worst, sameCount: a.length === b.length };
};

try {
  for (const [name] of Object.entries(golden).filter(([k]) => !k.startsWith("$"))) {
    console.log(`\n🧪 ${name}`);
    const html = sanitizeTemplateHtml((await pdf2htmlex.convert(fixture(name))).html);
    const coverage = computeFontCoverage(html);
    const fields = await resolveFields(name, html);
    assert(`${name}: every golden sample found in its line`, fields.every((f) => f.charStart >= 0), fields.filter((f) => f.charStart < 0).map((f) => f.key));

    // server-side align suggestion (D11) matches the golden anchor of every field
    const inspected = await renderer.withDocument(html, (page) => renderer.engine(page, "inspect", fields));
    const wrong = fields.filter((f) => inspected[f.key]?.suggestedAlign !== f.align).map((f) => `${f.key}: ${inspected[f.key]?.suggestedAlign} ≠ ${f.align}`);
    assert(`${name}: inspect suggests the golden align for all ${fields.length} fields`, wrong.length === 0, wrong);

    const { preparedHtml, geometry, report } = await runPrepare(html, fields, { fontCoverage: coverage });
    console.log(`     gate: passed=${report.passed} pixelDiff=${report.pixelDiffPct}% (${report.ms.total} ms)`);
    assert(`${name}: prepare gate passes`, report.passed, report.checks.filter((c) => !c.passed));
    assert(`${name}: round-trip pixel diff ≤ ${GATE.pixelDiffPct} %`, report.pixelDiffPct <= GATE.pixelDiffPct, report.pixelDiffPct);
    for (const f of fields) {
      const e = report.fields[f.key];
      assert(
        `${name}/${f.key}: calibration ≤ 0.5 px and round-trip ≤ 0.5 px`,
        e.ok && e.calibration.dx <= 0.5 && e.calibration.dw <= 0.5 && e.roundTrip.dx <= 0.5 && e.roundTrip.dw <= 0.5,
        e
      );
    }
    assert(`${name}: prepared HTML has empty field spans, no script`, (preparedHtml.match(/<span data-field="[a-z0-9_]+"[^>]*><\/span>/g) || []).length === fields.length && !/<script/i.test(preparedHtml));

    const defs = fields.map((f) => fillDef({ ...f, ...geometry[f.key] }));
    const samples = Object.fromEntries(fields.map((f) => [f.key, f.sampleValue]));
    const base = await neighbours(preparedHtml, defs, samples, coverage);
    assert(`${name}: samples refill without flags`, Object.values(base.flags).every((l) => l.length === 0), base.flags);

    for (const [label, set] of [["longer", LONGER], ["shorter", SHORTER]]) {
      const values = Object.fromEntries(fields.map((f) => [f.key, set[f.key]]));
      const res = await neighbours(preparedHtml, defs, values, coverage);
      const d = maxDrift(base.runs, res.runs);
      console.log(`     ${label} values: neighbour drift ${d.worst.toFixed(3)} px`);
      assert(`${name}: ${label} values → neighbours drift ≤ 0.5 px`, d.sameCount && d.worst <= 0.5, d);
      for (const f of fields.filter((x) => x.align === "center")) {
        const g0 = base.geometry[f.key];
        const g1 = res.geometry[f.key];
        const c0 = (g0.x0 + g0.x1) / 2;
        const c1 = (g1.x0 + g1.x1) / 2;
        assert(`${name}/${f.key}: ${label} value stays centered (Δ ${Math.abs(c1 - c0).toFixed(3)} px ≤ 0.5)`, Math.abs(c1 - c0) <= 0.5, { c0, c1 });
      }
    }

    // overflow: 3× the sample on every field. Limits = same-baseline neighbours,
    // else the design's text margins (owner decision 2026-10-17, plan §20 I10):
    // a value beyond its limits is flagged, a value within them is not, and
    // neighbours never move either way.
    const triple = Object.fromEntries(fields.map((f) => [f.key, `${f.sampleValue} ${f.sampleValue} ${f.sampleValue}`]));
    const natural = await renderFilled(preparedHtml, defs.map((d) => ({ ...d, limits: null })), triple, { fontCoverage: coverage });
    const over = await neighbours(preparedHtml, defs, triple, coverage);
    const overDrift = maxDrift(base.runs, over.runs);
    const beyond = fields.filter((f) => {
      const g = natural.geometry[f.key];
      const l = geometry[f.key].limits;
      return g.x0 < l.minX - 0.5 || g.x1 > l.maxX + 0.5;
    });
    console.log(`     3× values beyond their limits: ${beyond.map((f) => f.key).join(", ") || "none"}`);
    assert(`${name}: 3× beyond limits → shrunk/overflow`, beyond.every((f) => over.flags[f.key].some((x) => x === "shrunk" || x === "overflow")), over.flags);
    assert(`${name}: 3× within limits → no size flag`, fields.filter((f) => !beyond.includes(f)).every((f) => !over.flags[f.key].some((x) => x === "shrunk" || x === "overflow")), over.flags);
    assert(`${name}: at least one golden field exceeds its limits at 3×`, beyond.length > 0);
    assert(`${name}: shrunk values fit their limits`, fields.filter((f) => over.flags[f.key].includes("shrunk")).every((f) => over.geometry[f.key].x0 >= geometry[f.key].limits.minX - 0.5 && over.geometry[f.key].x1 <= geometry[f.key].limits.maxX + 0.5));
    assert(`${name}: 3× values → neighbours unmoved (≤ 0.5 px)`, overDrift.sameCount && overDrift.worst <= 0.5, overDrift);

    // empty values keep the layout and flag required fields
    const empty = await neighbours(preparedHtml, defs, {}, coverage);
    assert(`${name}: empty required values → missing`, fields.every((f) => empty.flags[f.key].includes("missing")), empty.flags);
    assert(`${name}: empty values → neighbours unmoved`, maxDrift(base.runs, empty.runs).worst <= 0.5);
  }

  console.log("\n🧪 Glyph coverage (ADDVET regular font lacks B X j x)");
  {
    const html = sanitizeTemplateHtml((await pdf2htmlex.convert(fixture("ADDVET_COA.ai"))).html);
    const coverage = computeFontCoverage(html);
    const fields = (await resolveFields("ADDVET_COA.ai", html)).filter((f) => f.key === "batch_no");
    const { preparedHtml, geometry } = await runPrepare(html, fields, { fontCoverage: coverage });
    const def = fillDef({ ...fields[0], ...geometry.batch_no });
    assert("batch_no uses the regular font ff1", def.fontClass === "ff1", def.fontClass);
    const { flags } = await renderFilled(preparedHtml, [def], { batch_no: "BX-1124" }, { fontCoverage: coverage });
    assert("value with B and X → glyph:BX", flags.batch_no.includes("glyph:BX"), flags.batch_no);
    const ok = await renderFilled(preparedHtml, [def], { batch_no: "AVVS1124011" }, { fontCoverage: coverage });
    assert("covered value → no glyph flag", !ok.flags.batch_no.some((x) => x.startsWith("glyph")), ok.flags.batch_no);
  }

  console.log("\n🧪 Gate failures are explicit");
  {
    const html = sanitizeTemplateHtml((await pdf2htmlex.convert(fixture("ADDVET_COA.ai"))).html);
    const fields = await resolveFields("ADDVET_COA.ai", html);
    const bad = [{ ...fields[0], sampleValue: "WRONG" }];
    const { report } = await runPrepare(html, bad, {});
    assert("wrong sample → OFFSET_MISMATCH, gate fails", !report.passed && report.fields.batch_no.error === "OFFSET_MISMATCH", report.fields);
    const { report: none } = await runPrepare(html, [], {});
    assert("no fields → gate fails (has_fields)", !none.passed && none.checks.find((c) => c.id === "has_fields").passed === false);
  }
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, () => renderer.shutdown());
