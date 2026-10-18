import * as renderer from "../engine/renderer.js";
import { comparePngs } from "../engine/pixelDiff.js";

// The prepare pipeline (CERTIFICATES_V2_PLAN.md §7.3, §7.5, §7.6) as a pure
// function over HTML — no database. prepareService persists its result.
//
//   sanitized HTML ──clear(fields)──► prepared HTML (empty <span data-field>)
//   prepared ──fill(sampleValues)──► round-trip render ── compare ──► gate
//
// Every number comes from the same headless Chromium that renders and prints
// certificates (D11).

export const GATE = {
  calibrationPx: 0.5,
  roundTripPx: 0.5,
  pixelDiffPct: 0.05,
  overlapAreaPx2: 0.25,
};

const intersectionArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** Field definition as the engine's fill() needs it, from a TemplateField-like object. */
export const fillDef = (f) => ({
  key: f.key,
  box: f.box,
  limits: f.limits,
  scale: f.scale,
  align: f.align || "left",
  required: f.required !== false,
  fontClass: f.fontClass,
});

/**
 * fields: [{ key, page, lineId, charStart, charEnd, sampleValue, align }]
 * → { preparedHtml, geometry: { [key]: {...} }, report, diffImages: [{ page, png }] }
 * `report.passed` is the gate verdict. Throws only on infrastructure errors.
 */
export async function runPrepare(sanitizedHtml, fields, { fontCoverage = null } = {}) {
  const t0 = Date.now();

  // 1) clear — on a copy of the sanitized document (§7.3)
  const cleared = await renderer.withDocument(
    sanitizedHtml,
    async (page) => {
      const { results } = await renderer.engine(page, "clear", fields.map((f) => ({ key: f.key, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue, align: f.align })));
      const html = await renderer.serialize(page);
      return { results, html };
    },
    { label: "prepare:clear" }
  );
  const tClear = Date.now();

  const okFields = fields.filter((f) => cleared.results[f.key]?.ok);
  const defs = okFields.map((f) => fillDef({ ...f, ...cleared.results[f.key] }));
  const samples = Object.fromEntries(okFields.map((f) => [f.key, f.sampleValue]));

  // 2) round-trip — refill every field with its own sample value (§7.5)
  const roundTrip = await renderer.withDocument(
    cleared.html,
    async (page) => {
      const fill = await renderer.engine(page, "fill", samples, defs, fontCoverage);
      const rects = await renderer.engine(page, "measure", okFields.map((f) => f.key));
      const shots = await renderer.screenshotPagesOf(page);
      return { fill, rects, shots };
    },
    { label: "prepare:roundtrip" }
  );
  const originalShots = await renderer.screenshotPages(sanitizedHtml);
  const tRender = Date.now();

  // 3) pixel comparison per page
  const pages = [];
  const diffImages = [];
  for (const orig of originalShots) {
    const refilled = roundTrip.shots.find((s) => s.page === orig.page);
    if (!refilled) {
      pages.push({ page: orig.page, pixelDiffPct: 100, diffPixels: null, error: "page missing after prepare" });
      continue;
    }
    const d = await comparePngs(orig.png, refilled.png);
    pages.push({ page: orig.page, pixelDiffPct: +d.pct.toFixed(4), diffPixels: d.diffPixels, sizeMismatch: d.sizeMismatch });
    diffImages.push({ page: orig.page, png: d.diffPng });
  }

  // 4) per-field gate data
  const fieldReport = {};
  for (const f of fields) {
    const r = cleared.results[f.key] || { ok: false, error: "NOT_PROCESSED" };
    const entry = { ok: r.ok, error: r.error || null };
    if (r.ok) {
      const rect = roundTrip.rects[f.key];
      entry.calibration = r.calibration;
      entry.roundTrip = rect ? { dx: +Math.abs(rect.x - r.box.x).toFixed(3), dw: +Math.abs(rect.w - r.box.w).toFixed(3) } : null;
      entry.transparent = r.transparent;
      entry.flags = roundTrip.fill.flags[f.key] || [];
      entry.overlapsWith = [];
    } else if (r.found !== undefined) {
      entry.found = r.found;
    }
    fieldReport[f.key] = entry;
  }
  for (let i = 0; i < okFields.length; i++) {
    for (let j = i + 1; j < okFields.length; j++) {
      const a = okFields[i];
      const b = okFields[j];
      if ((a.page || 1) !== (b.page || 1)) continue;
      if (intersectionArea(cleared.results[a.key].box, cleared.results[b.key].box) > GATE.overlapAreaPx2) {
        fieldReport[a.key].overlapsWith.push(b.key);
        fieldReport[b.key].overlapsWith.push(a.key);
      }
    }
  }

  // 5) the gate (§7.6)
  const list = (pred) => fields.filter((f) => pred(fieldReport[f.key])).map((f) => f.key);
  const checks = [
    { id: "has_fields", label: "At least one field defined", passed: fields.length >= 1, failing: [] },
    { id: "offsets", label: "Every field found at its offsets (no OFFSET_MISMATCH)", failing: list((e) => !e.ok) },
    { id: "calibration", label: `Calibration within ${GATE.calibrationPx} px`, failing: list((e) => e.ok && (e.calibration.dx > GATE.calibrationPx || e.calibration.dw > GATE.calibrationPx)) },
    { id: "round_trip", label: `Round-trip position/width within ${GATE.roundTripPx} px`, failing: list((e) => e.ok && (!e.roundTrip || e.roundTrip.dx > GATE.roundTripPx || e.roundTrip.dw > GATE.roundTripPx)) },
    { id: "pixel_diff", label: `Round-trip page pixel diff ≤ ${GATE.pixelDiffPct} %`, failing: pages.filter((p) => !(p.pixelDiffPct <= GATE.pixelDiffPct)).map((p) => `page ${p.page}`) },
    { id: "transparent", label: "No field inside a transparent ancestor", failing: list((e) => e.ok && e.transparent) },
    { id: "overlap", label: "No two fields overlapping", failing: list((e) => e.ok && e.overlapsWith.length > 0) },
  ].map((c) => ({ ...c, passed: c.passed ?? c.failing.length === 0 }));

  const geometry = Object.fromEntries(
    okFields.map((f) => {
      const r = cleared.results[f.key];
      return [f.key, { box: r.box, limits: r.limits, letterSpacing: r.letterSpacing, fontClass: r.fontClass, scale: r.scale }];
    })
  );

  const report = {
    passed: checks.every((c) => c.passed),
    checks,
    fields: fieldReport,
    pages,
    pixelDiffPct: pages.length ? Math.max(...pages.map((p) => p.pixelDiffPct)) : null,
    thresholds: GATE,
    ms: { clear: tClear - t0, render: tRender - tClear, total: Date.now() - t0 },
    preparedAt: new Date().toISOString(),
  };
  return { preparedHtml: cleared.html, geometry, report, diffImages };
}

/**
 * Renders a prepared document with `values` → { html, flags, geometry, thumbnail? } (static HTML, D9).
 * `thumbnailScale` (e.g. 0.25) also returns a PNG of page 1 from the same render.
 */
export async function renderFilled(preparedHtml, defs, values, { fontCoverage = null, label = "fill", thumbnailScale = null } = {}) {
  return renderer.withDocument(
    preparedHtml,
    async (page) => {
      const res = await renderer.engine(page, "fill", values, defs, fontCoverage);
      const html = await renderer.serialize(page);
      const thumbnail = thumbnailScale ? (await renderer.screenshotPagesOf(page, { scale: thumbnailScale }))[0]?.png || null : null;
      return { html, flags: res.flags, geometry: res.geometry, thumbnail };
    },
    { label }
  );
}
