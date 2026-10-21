// Certificates V2 Phase 7 — repeating groups through the real field engine
// (in-process renderer, no API; CERTIFICATES_V2_PLAN.md §7.8, §16.2).
// For ADDVET (a list inside one cell) and PHARMAVET (full table rows):
//  - SVG conversion + normalisation (cairo blend → mix-blend-mode, constant masks → opacity)
//  - detection: shape, sample rows, pitch, footer line proposal, capacity
//  - prepare gate with the group: round-trip with the original rows ≤ 0.05 %
//  - fills N = 0 (dash, hide), 1, sample count, 2×, overflow: row order and
//    pitch, the content below moves by exactly the delta, footer / watermark /
//    side margins never move, N = 1 looks like one normal row, PDF per page
//  - fixed rows (the designer's fallback) on SVG and on a raster background
//  - detection failures: raster background, rules drawn as one shape
//  - no hairline: the exported PDF, drawn by Chrome's viewer (PDFium), adds no
//    ink on paper the original design leaves blank (the raw, un-normalised SVG
//    export is the negative control: it must show the box)
// Needs the pdf2htmlex service (with ?bg=svg).
import { fixture, makeAssert, finish } from "./helpers.js";
import * as pdf2htmlex from "../../src/services/certificates/conversion/pdf2htmlexClient.js";
import { sanitizeTemplateHtml } from "../../src/services/certificates/sanitize/htmlSanitizer.js";
import * as renderer from "../../src/services/certificates/engine/renderer.js";
import { comparePngs } from "../../src/services/certificates/engine/pixelDiff.js";
import { computeFontCoverage } from "../../src/services/certificates/analysis/fontCoverage.js";
import { runPrepare, renderFilled, fillDef, groupFillDef, inspectDef, GATE } from "../../src/services/certificates/templates/prepareEngine.js";
import { rasterizePdfium, extraInk, closeRaster } from "./pdfRaster.js";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { assert, counts } = makeAssert();

const LIST = [
  ["Vitamin E", "120000 mg"], ["Sodium selenite", "60 mg"], ["Distillate water up to", "1000 mL"], ["Vitamin A", "5000000 IU"],
  ["Vitamin D3", "1000000 IU"], ["Biotin", "50 mg"], ["Vitamin K3", "2000 mg"], ["Folic acid", "300 mg"], ["Nicotinamide", "15000 mg"],
  ["Vitamin C", "10 mg"], ["Choline chloride", "40000 mg"], ["Zinc sulfate", "800 mg"], ["Copper sulfate", "100 mg"], ["Manganese", "60 mg"],
  ["Iodine", "1 mg"], ["Cobalt", "2 mg"], ["Iron", "5 mg"], ["Selenium", "3 mg"],
].map(([name, amount]) => ({ name, amount }));

const CASES = {
  "ADDVET_COA.ai": {
    plain: [
      { key: "batch_no", lineId: "p1-l11", sampleValue: "AVVS1122005" },
      { key: "product_name", lineId: "p1-l14", sampleValue: "ADD-E120" },
      { key: "ph_result", lineId: "p1-l21", sampleValue: "4.0", last: true },
    ],
    cells: [["name", "p1-l22", "Vitamin E"], ["amount", "p1-l25", "120000 mg"]],
    shape: "cell_list",
    sampleRowCount: 3,
    footer: [790, 806], // just above the signature
    belowLine: "p1-l28", // "Sterility …"
  },
  "PHARMAVET_COA.pdf": {
    plain: [
      { key: "batch_no", lineId: "p1-l12", sampleValue: "HSPhar02509001", align: "center" },
      { key: "ph_result", lineId: "p1-l16", sampleValue: "2.6", last: true },
    ],
    cells: [["name", "p1-l17", "Doxycycline hyclate"], ["amount", "p1-l17", "500 mg", true]],
    shape: "table_rows",
    sampleRowCount: 1,
    footer: [850, 866], // just above the stamp
    belowLine: "p1-l18",
  },
};

// a hairline is a straight run of new ink this long (px); text stays far below
const HAIRLINE_PX = 30;

async function convert(name, background, { normalize = true } = {}) {
  const out = await pdf2htmlex.convert(fixture(name), { background });
  let html = sanitizeTemplateHtml(out.html);
  let stats = null;
  if (background === "svg" && normalize) {
    const norm = await renderer.normalizeBackground(html);
    html = sanitizeTemplateHtml(norm.html);
    stats = norm.stats;
  }
  return { html, stats, bg: out.bg };
}

function fieldsFor(spec, lines, group = "constituents") {
  const at = (lineId, v, last) => {
    const t = lines.find((l) => l.id === lineId)?.text || "";
    const s = last ? t.lastIndexOf(v) : t.indexOf(v);
    return { charStart: s, charEnd: s + v.length };
  };
  const plain = spec.plain.map((p, i) => ({ key: p.key, label: p.key, lineId: p.lineId, sampleValue: p.sampleValue, align: p.align || "left", page: 1, sortOrder: i, ...at(p.lineId, p.sampleValue, p.last) }));
  const cells = spec.cells.map(([key, lineId, v, last], i) => ({ key, label: key, lineId, sampleValue: v, align: "left", page: 1, sortOrder: 100 + i, groupKey: group, ...at(lineId, v, last) }));
  return [...plain, ...cells];
}

// what the filled document looks like
const probe = (html, geo) =>
  renderer.withDocument(html, async (page) => {
    const doc = await page.evaluate(() => {
      const pageEl = document.querySelector("[data-page]");
      const pr = pageEl.getBoundingClientRect();
      const rel = (r) => ({ x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height });
      const cells = Array.from(document.querySelectorAll("[data-group-cell]")).map((s) => {
        const [, row, key] = s.getAttribute("data-group-cell").split(":");
        return { row: Number(row), key, text: s.textContent, box: rel(s.getBoundingClientRect()) };
      });
      const lines = Array.from(document.querySelectorAll("[data-line]")).map((l) => {
        const r = document.createRange();
        r.selectNodeContents(l);
        return { id: l.getAttribute("data-line"), text: l.textContent, box: rel(r.getBoundingClientRect()) };
      });
      return { cells, lines };
    });
    const units = geo ? await renderer.engine(page, "backgroundUnits", geo) : [];
    return { ...doc, units };
  });

async function pdfInfo(html) {
  const { pdf, pages } = await renderer.printPdf(html);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const [, , w, h] = page.view;
  const text = (await page.getTextContent()).items.map((i) => i.str).join(" ").replace(/\s+/g, " ");
  const ops = await page.getOperatorList();
  let biggestImage = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject || ops.fnArray[i] === pdfjs.OPS.paintInlineImageXObject) biggestImage = Math.max(biggestImage, ops.argsArray[i][1] * ops.argsArray[i][2]);
  }
  return { pdf, pages, pdfPages: doc.numPages, w, h, text, biggestImage };
}

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
// a character the subset font lacks is drawn in a fallback font: pdf.js returns
// it as its own text run ("B iotin"), so compare without whitespace
const squash = (t) => String(t).replace(/\s+/g, "");
const rowsOf = (cells) => {
  const out = [];
  for (const c of cells) (out[c.row] = out[c.row] || {})[c.key] = c;
  return out;
};

try {
  for (const [name, spec] of Object.entries(CASES)) {
    console.log(`\n🧪 ${name} — repeating group (${spec.shape})`);
    const { html, stats, bg } = await convert(name, "svg");
    assert(`${name}: converter returned an SVG background`, bg === "svg" && /data:image\/svg\+xml;base64,/.test(html));
    assert(`${name}: normalisation rewrote the blend layer and the constant masks`, stats.images === 1 && stats.blendsRewritten === 1 && stats.masksToOpacity >= 1, stats);
    const coverage = computeFontCoverage(html);
    const { lines } = await renderer.analyse(html);
    const fields = fieldsFor(spec, lines);
    // the design as Chrome's PDF viewer draws it — the hairline reference
    const original = await rasterizePdfium(fixture(name));
    {
      const raw = await convert(name, "svg", { normalize: false });
      const ink = extraInk(await rasterizePdfium((await renderer.printPdf(raw.html)).pdf), original);
      const run = Math.max(ink.longestH, ink.longestV);
      assert(`${name}: negative control — the un-normalised SVG export shows the hairline box (run ${run} px ≥ ${HAIRLINE_PX})`, run >= HAIRLINE_PX, ink);
    }
    assert(`${name}: every sample found in its line`, fields.every((f) => f.charStart >= 0), fields.filter((f) => f.charStart < 0).map((f) => f.key));
    const group = { key: "constituents", mode: "repeat", whenEmpty: "dash", required: true };

    const detected = await renderer.withDocument(html, (page) => renderer.engine(page, "inspectGroups", [inspectDef(group, fields)]));
    const d = detected.constituents;
    assert(`${name}: group detected as ${spec.shape} with ${spec.sampleRowCount} sample row(s)`, d.ok && d.shape === spec.shape && d.sampleRowCount === spec.sampleRowCount, d);
    assert(`${name}: footer line proposed above the signature/stamp (${d.footerProposal})`, d.footerProposal >= spec.footer[0] && d.footerProposal <= spec.footer[1], d.footerProposal);
    assert(`${name}: capacity at 85 % pitch ≥ at full pitch ≥ sample rows`, d.capacity.min >= d.capacity.full && d.capacity.full >= spec.sampleRowCount, d.capacity);

    const t0 = Date.now();
    const prep = await runPrepare(html, fields, { fontCoverage: coverage, groups: [group] });
    console.log(`     gate: passed=${prep.report.passed} pixelDiff=${prep.report.pixelDiffPct}% (${Date.now() - t0} ms)`);
    assert(`${name}: prepare gate passes with the group (incl. "groups" check)`, prep.report.passed && prep.report.checks.some((c) => c.id === "groups" && c.passed), prep.report.checks.filter((c) => !c.passed));
    assert(`${name}: round-trip with the original rows ≤ ${GATE.pixelDiffPct} %`, prep.report.pixelDiffPct <= GATE.pixelDiffPct, prep.report.pixelDiffPct);
    const geo = prep.groupGeometry.constituents;
    assert(`${name}: placeholder rows removed from the prepared document`, (geo.placeholderLines || []).every((id) => !prep.preparedHtml.includes(`data-line="${id}"`)));

    const withGeo = fields.map((f) => ({ ...f, ...prep.geometry[f.key] }));
    const defs = withGeo.filter((f) => !f.groupKey).map(fillDef);
    const plainValues = Object.fromEntries(fields.filter((f) => !f.groupKey).map((f) => [f.key, f.sampleValue]));
    const sanitizedShot = (await renderer.screenshotPages(html))[0];
    const base = await probe(prep.preparedHtml, geo);
    const baseBelow = base.lines.find((l) => l.id === spec.belowLine);
    const keep = (u) => ["faint", "pinned", "margin"].includes(u.cat);
    const kept = base.units.filter(keep);
    const footerLines = base.lines.filter((l) => l.box.y >= geo.footerY);

    const k = spec.sampleRowCount;
    const overflowN = geo.capacity.min + 2;
    const runs = [
      ["N = 0 (dash)", 0, "dash"],
      ["N = 0 (hide)", 0, "hide"],
      ["N = 1", 1, "dash"],
      [`N = ${k} (sample count)`, k, "dash"],
      [`N = ${2 * k} (2×)`, 2 * k, "dash"],
      [`N = ${overflowN} (overflow)`, overflowN, "dash"],
    ];
    for (const [label, n, whenEmpty] of runs) {
      const rows = n === k ? geo.sampleRows : LIST.slice(0, n);
      const gdef = groupFillDef({ ...group, whenEmpty, geometry: geo }, withGeo);
      const out = await renderFilled(prep.preparedHtml, defs, { ...plainValues, constituents: rows }, { fontCoverage: coverage, groups: [gdef] });
      const flags = out.flags.constituents;
      const info = out.geometry.constituents;
      const after = await probe(out.html, geo);
      const got = rowsOf(after.cells);
      console.log(`     ${label}: rendered ${info.rendered} · pitch ${info.pitch} · Δ ${info.delta} · rowsFit ${info.rowsFit} · flags ${JSON.stringify(flags)}`);

      if (n === 0 && whenEmpty === "dash") {
        assert(`${name} ${label}: one row showing "—", flagged missing`, info.rendered === 1 && got.length === 1 && got[0].name.text === "—" && flags.includes("missing"), { flags, got: got.map((r) => r.name.text) });
      } else if (n === 0) {
        assert(`${name} ${label}: no row, the label is gone, flagged missing`, info.rendered === 0 && got.length === 0 && flags.includes("missing") && !after.lines.some((l) => /Constituents/.test(l.text)), flags);
      } else {
        const texts = got.map((r) => `${r.name.text}|${r.amount.text}`);
        assert(`${name} ${label}: ${n} rows, in order, with their values`, texts.length === n && texts.every((t, i) => t === `${rows[i].name}|${rows[i].amount}`), texts.slice(0, 4));
        const steps = got.slice(1).map((r, i) => r.name.box.y - got[i].name.box.y);
        assert(`${name} ${label}: rows ${info.pitch} px apart`, steps.every((s) => near(s, info.pitch)), steps.slice(0, 4));
        const overflow = n > geo.capacity.min;
        assert(`${name} ${label}: ${overflow ? `overflow flagged, ${geo.capacity.min} rows fit` : "no overflow flag"}`, overflow ? flags.includes("overflow") && info.rowsFit === geo.capacity.min : !flags.includes("overflow"), { flags, rowsFit: info.rowsFit });
        assert(`${name} ${label}: pitch ${n > geo.capacity.full ? "shrunk (≥ 85 %)" : "unchanged"}`, n > geo.capacity.full ? flags.includes("shrunk") && info.pitch >= geo.pitch * 0.85 - 0.01 : near(info.pitch, geo.pitch, 0.01) && !flags.includes("shrunk"), info.pitch);
        if (!overflow) {
          const lastBottom = Math.max(...after.cells.map((c) => c.box.y + c.box.h));
          const below = after.lines.find((l) => l.id === spec.belowLine);
          assert(`${name} ${label}: no overlap — the next row starts below the last group row`, below.box.y > lastBottom, { lastBottom, below: below.box.y });
        }
      }
      // the content below moves by exactly the delta; the footer, watermark and margins never move
      const below = after.lines.find((l) => l.id === spec.belowLine);
      assert(`${name} ${label}: content below moved by Δ ${info.delta} px`, near(below.box.y - baseBelow.box.y, info.delta), below.box.y - baseBelow.box.y);
      const movedFooter = footerLines.filter((l) => {
        const a = after.lines.find((x) => x.id === l.id);
        return !a || !near(a.box.y, l.box.y) || !near(a.box.x, l.box.x);
      });
      assert(`${name} ${label}: text below the footer line unmoved (${footerLines.length} lines)`, movedFooter.length === 0, movedFooter.map((l) => l.id));
      const lost = kept.filter((u) => !after.units.some((v) => v.cat === u.cat && near(v.box.x, u.box.x, 0.2) && near(v.box.y, u.box.y, 0.2) && near(v.box.w, u.box.w, 0.2) && near(v.box.h, u.box.h, 0.2)));
      assert(`${name} ${label}: watermark, footer drawing and side margins untouched (${kept.length} elements)`, lost.length === 0, lost.slice(0, 3));

      if (n === 1 && spec.shape === "cell_list") {
        // N = 1 must look exactly like one normal row of the table
        const height = geo.band.y1 + info.delta - geo.band.y0;
        const offset = got[0].name.box.y - geo.band.y0;
        assert(`${name} N = 1 looks like a normal row: height ${height.toFixed(2)} ≈ ${geo.normalRow.height.toFixed(2)}, text offset ${offset.toFixed(2)} ≈ ${geo.normalRow.textOffset.toFixed(2)}`, near(height, geo.normalRow.height) && near(offset, geo.normalRow.textOffset), { height, offset });
      }
      if (n === k) {
        const [shot] = await renderer.screenshotPages(out.html);
        const diff = await comparePngs(sanitizedShot.png, shot.png);
        assert(`${name} ${label}: the original rows render like the design (${diff.pct.toFixed(4)} % ≤ ${GATE.pixelDiffPct} %)`, diff.pct <= GATE.pixelDiffPct, diff.pct);
      }
      const pdf = await pdfInfo(out.html);
      const missingText = (n === 0 ? [] : rows.slice(0, Math.min(n, info.rendered))).flatMap((r) => [r.name, r.amount]).filter((t) => !squash(pdf.text).includes(squash(t)));
      assert(
        `${name} ${label}: PDF — 1 page, A4 (Δ < 0.35 pt), row text extractable, no page-sized raster`,
        pdf.pages === 1 && pdf.pdfPages === 1 && Math.abs(pdf.w - 595.28) < 0.35 && Math.abs(pdf.h - 841.89) < 0.35 && missingText.length === 0 && pdf.biggestImage < 0.5 * 2481 * 3510,
        { pages: pdf.pdfPages, w: pdf.w, h: pdf.h, missingText: missingText.slice(0, 3), biggestImage: pdf.biggestImage }
      );
      if (n === k) {
        // same content as the design: new ink on blank paper is an artefact (the hairline box)
        const ink = extraInk(await rasterizePdfium(pdf.pdf), original);
        const run = Math.max(ink.longestH, ink.longestV);
        assert(`${name} ${label}: PDF in Chrome's viewer — no hairline (longest new-ink run ${run} px < ${HAIRLINE_PX})`, run < HAIRLINE_PX, ink);
      }
    }
    if (name === "ADDVET_COA.ai") {
      const gdef = groupFillDef({ ...group, geometry: geo }, withGeo);
      const out = await renderFilled(prep.preparedHtml, defs, { ...plainValues, constituents: LIST.slice(0, 6) }, { fontCoverage: coverage, groups: [gdef] });
      assert("ADDVET: a list value with B (font lacks it) → one merged glyph:B flag", out.flags.constituents.filter((f) => f.startsWith("glyph:")).length === 1 && out.flags.constituents.includes("glyph:B"), out.flags.constituents);
    }
  }

  console.log("\n🧪 Fixed rows (designer's fallback) — ADDVET, the 3 drawn rows are the maximum");
  for (const background of ["svg", "png"]) {
    const { html } = await convert("ADDVET_COA.ai", background);
    const coverage = computeFontCoverage(html);
    const { lines } = await renderer.analyse(html);
    const fields = fieldsFor(CASES["ADDVET_COA.ai"], lines);
    const group = { key: "constituents", mode: "fixed_rows", whenEmpty: "hide", required: false };
    const prep = await runPrepare(html, fields, { fontCoverage: coverage, groups: [group] });
    const geo = prep.groupGeometry.constituents;
    assert(`fixed rows (${background}): prepare gate passes, 3 drawn rows, round-trip ${prep.report.pixelDiffPct} %`, prep.report.passed && geo?.sampleRowCount === 3 && prep.report.pixelDiffPct <= GATE.pixelDiffPct, prep.report.checks.filter((c) => !c.passed));
    if (!geo) continue;
    const withGeo = fields.map((f) => ({ ...f, ...prep.geometry[f.key] }));
    const defs = withGeo.filter((f) => !f.groupKey).map(fillDef);
    const plainValues = Object.fromEntries(fields.filter((f) => !f.groupKey).map((f) => [f.key, f.sampleValue]));
    const base = await probe(prep.preparedHtml, null);
    const sterility0 = base.lines.find((l) => l.id === "p1-l28").box.y;
    for (const [n, whenEmpty] of [[1, "hide"], [3, "hide"], [4, "hide"], [0, "hide"]]) {
      const gdef = groupFillDef({ ...group, whenEmpty, geometry: geo }, withGeo);
      const out = await renderFilled(prep.preparedHtml, defs, { ...plainValues, constituents: LIST.slice(0, n) }, { fontCoverage: coverage, groups: [gdef] });
      const info = out.geometry.constituents;
      const flags = out.flags.constituents;
      const after = await probe(out.html, null);
      const moved = after.lines.find((l) => l.id === "p1-l28").box.y - sterility0;
      const expected = n === 0 ? -(geo.band.y1 - geo.band.y0) : -(3 - Math.min(n, 3)) * geo.pitch;
      console.log(`     ${background} N = ${n}: rendered ${info.rendered} · Δ ${info.delta} · flags ${JSON.stringify(flags)}`);
      assert(`fixed rows (${background}) N = ${n}: unused rows hidden, gap closed (content below moved ${moved.toFixed(2)} ≈ ${expected.toFixed(2)})`, near(moved, expected) && after.cells.filter((c) => c.key === "name").length === Math.min(n, 3), { moved, expected });
      if (n > 3) assert(`fixed rows (${background}) N = ${n}: overflow, 3 rows fit`, flags.includes("overflow") && info.rowsFit === 3, flags);
      if (n === 1) {
        const pdf = await pdfInfo(out.html);
        assert(`fixed rows (${background}) N = 1: PDF is 1 page with the row text`, pdf.pdfPages === 1 && squash(pdf.text).includes("VitaminE") && !squash(pdf.text).includes("Sodiumselenite"), pdf.text.slice(0, 80));
      }
    }
  }

  console.log("\n🧪 Detection failures are refused with a clear reason");
  {
    const { html } = await convert("ADDVET_COA.ai", "png");
    const { lines } = await renderer.analyse(html);
    const fields = fieldsFor(CASES["ADDVET_COA.ai"], lines);
    const r = await renderer.withDocument(html, (page) => renderer.engine(page, "inspectGroups", [inspectDef({ key: "constituents", mode: "repeat" }, fields)]));
    assert("raster (PNG) background → GROUP_NEEDS_SVG", r.constituents.ok === false && r.constituents.error === "GROUP_NEEDS_SVG", r.constituents);

    // the same design with a table rule drawn as ONE stroke from the table
    // header down past the group row (placed from the detected geometry)
    const svg = (await convert("ADDVET_COA.ai", "svg")).html;
    const svgFields = fieldsFor(CASES["ADDVET_COA.ai"], (await renderer.analyse(svg)).lines);
    const found = (await renderer.withDocument(svg, (page) => renderer.engine(page, "inspectGroups", [inspectDef({ key: "constituents", mode: "repeat" }, svgFields)]))).constituents;
    assert("the probe design is detectable before the combined stroke is added", found.ok === true, found);
    const combined = await renderer.withDocument(svg, async (page) => {
      await page.evaluate(async (geo) => {
        const img = document.querySelector("img.bf, img.bi");
        const b64 = img.getAttribute("src").split(",")[1];
        const txt = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
        // page CSS px → the SVG's user units
        const pr = document.querySelector("[data-page]").getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        const vb = doc.documentElement.getAttribute("viewBox").split(/[\s,]+/).map(Number);
        const ux = (x) => ((x - (ir.left - pr.left)) * vb[2]) / ir.width;
        const uy = (y) => ((y - (ir.top - pr.top)) * vb[3]) / ir.height;
        const x = (geo.table.x0 + geo.table.x1) / 2;
        const p = doc.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", `M ${ux(x)} ${uy(geo.band.y0 - 30)} L ${ux(x)} ${uy(geo.band.y1 + 30)}`);
        p.setAttribute("stroke", "#999");
        p.setAttribute("stroke-width", "0.5");
        p.setAttribute("fill", "none");
        doc.documentElement.appendChild(p);
        const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(doc.documentElement));
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        img.setAttribute("src", `data:image/svg+xml;base64,${btoa(bin)}`);
        await img.decode().catch(() => {});
      }, found);
      return renderer.serialize(page);
    });
    const r2 = await renderer.withDocument(combined, (page) => renderer.engine(page, "inspectGroups", [inspectDef({ key: "constituents", mode: "repeat" }, fields)]));
    assert("rules drawn as one shape across the row → GROUP_RULES_COMBINED, message names the fixed-rows fallback", r2.constituents.ok === false && r2.constituents.error === "GROUP_RULES_COMBINED" && /fixed rows/i.test(r2.constituents.message), r2.constituents);
    const r3 = await renderer.withDocument(combined, (page) => renderer.engine(page, "inspectGroups", [inspectDef({ key: "constituents", mode: "fixed_rows" }, fields)]));
    assert("…and the same design is accepted as fixed rows", r3.constituents.ok === true && r3.constituents.sampleRowCount === 3, r3.constituents);
  }
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await closeRaster();
  await renderer.shutdown();
});
