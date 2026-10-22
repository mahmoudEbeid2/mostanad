import * as renderer from "../engine/rendererClient.js";
import { comparePngs } from "../engine/pixelDiff.js";

// The prepare pipeline (CERTIFICATES_V2_PLAN.md §7.3, §7.5, §7.6) as a pure
// function over HTML — no database. prepareService persists its result.
//
//   sanitized HTML ──clear(fields)──► prepared HTML (empty <span data-field>)
//   prepared ──fill(sampleValues)──► round-trip render ── compare ──► gate
//
// Every number comes from the same headless Chromium that renders and prints
// certificates (D11) — the cert-renderer service, through rendererClient.

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

/** A group's cells (fields with groupKey) for the engine's inspectGroups(). */
export const inspectDef = (g, fields) => ({
  key: g.key,
  mode: g.mode || "repeat",
  sampleRows: g.sampleRows ?? null,
  footerY: g.footerY ?? null,
  minPitchRatio: g.minPitchRatio ?? 0.85,
  cells: fields.filter((f) => f.groupKey === g.key).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((f) => ({ key: f.key, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue })),
});

/** Group definition as the engine's fill() needs it (§7.8). `fields` carry prepare geometry. */
export const groupFillDef = (g, fields) => ({
  key: g.key,
  mode: g.mode || "repeat",
  whenEmpty: g.whenEmpty || "dash",
  required: g.required !== false,
  footerY: g.footerY ?? g.geometry?.footerY ?? null,
  minPitchRatio: g.minPitchRatio ?? 0.85,
  geometry: g.geometry,
  cells: fields.filter((f) => f.groupKey === g.key).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map(fillDef),
});

/**
 * fields: [{ key, page, lineId, charStart, charEnd, sampleValue, align, groupKey? }]
 * groups: [{ key, mode, whenEmpty, required, footerY, minPitchRatio, sampleRows }] (§7.8)
 * → { preparedHtml, geometry: { [key]: {...} }, groupGeometry: { [key]: {...} }, report, diffImages: [{ page, png }] }
 * `report.passed` is the gate verdict. Throws only on infrastructure errors.
 */
export async function runPrepare(sanitizedHtml, fields, { fontCoverage = null, groups = [] } = {}) {
  const t0 = Date.now();

  // 1) detect groups on the untouched document, clear every field (group
  //    cells included), then remove the groups' placeholder rows (§7.3, §7.8)
  const cleared = await renderer.prepareClear(sanitizedHtml, {
    inspectDefs: groups.map((g) => inspectDef(g, fields)),
    clearFields: fields.map((f) => ({ key: f.key, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue, align: f.align })),
  });
  const tClear = Date.now();

  const okFields = fields.filter((f) => cleared.results[f.key]?.ok);
  const plainFields = okFields.filter((f) => !f.groupKey);
  const defs = plainFields.map((f) => fillDef({ ...f, ...cleared.results[f.key] }));
  const samples = Object.fromEntries(plainFields.map((f) => [f.key, f.sampleValue]));
  const withGeometry = okFields.map((f) => ({ ...f, ...cleared.results[f.key] }));
  const okGroups = groups.filter((g) => cleared.detected[g.key]?.ok && inspectDef(g, fields).cells.every((c) => cleared.results[c.key]?.ok));
  const groupDefs = okGroups.map((g) => groupFillDef({ ...g, geometry: cleared.detected[g.key], footerY: g.footerY ?? cleared.detected[g.key].footerY }, withGeometry));
  for (const g of okGroups) samples[g.key] = cleared.detected[g.key].sampleRows;

  // 2) round-trip — refill every field with its own sample value, every group
  //    with its sample rows (§7.5)
  const roundTrip = await renderer.prepareRoundTrip(cleared.html, {
    samples,
    defs,
    fontCoverage,
    groupDefs,
    measureKeys: plainFields.map((f) => f.key).concat(okGroups.length ? okFields.filter((f) => f.groupKey).map((f) => f.key) : []),
  });
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
      entry.flags = roundTrip.fill.flags[f.groupKey || f.key] || [];
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
    ...(groups.length
      ? [{ id: "groups", label: "Every repeating group found in the design (rows, rules, footer line)", failing: groups.filter((g) => !okGroups.includes(g)).map((g) => `${g.key}: ${cleared.detected[g.key]?.error || "a cell was not cleared"}`) }]
      : []),
  ].map((c) => ({ ...c, passed: c.passed ?? c.failing.length === 0 }));

  const geometry = Object.fromEntries(
    okFields.map((f) => {
      const r = cleared.results[f.key];
      return [f.key, { box: r.box, limits: r.limits, letterSpacing: r.letterSpacing, fontClass: r.fontClass, scale: r.scale }];
    })
  );

  const groupGeometry = Object.fromEntries(okGroups.map((g) => [g.key, cleared.detected[g.key]]));
  const groupReport = Object.fromEntries(
    groups.map((g) => {
      const d = cleared.detected[g.key] || {};
      return [g.key, d.ok ? { ok: true, shape: d.shape, sampleRowCount: d.sampleRowCount, pitch: d.pitch, footerY: d.footerY, footerProposal: d.footerProposal, capacity: d.capacity, flags: roundTrip.fill.flags[g.key] || [] } : { ok: false, error: d.error || "NOT_PROCESSED", message: d.message || null }];
    })
  );

  const report = {
    passed: checks.every((c) => c.passed),
    checks,
    fields: fieldReport,
    groups: groupReport,
    pages,
    pixelDiffPct: pages.length ? Math.max(...pages.map((p) => p.pixelDiffPct)) : null,
    thresholds: GATE,
    ms: { clear: tClear - t0, render: tRender - tClear, total: Date.now() - t0 },
    preparedAt: new Date().toISOString(),
  };
  return { preparedHtml: cleared.html, geometry, groupGeometry, report, diffImages };
}

/**
 * Renders a prepared document with `values` → { html, flags, geometry, thumbnail? } (static HTML, D9).
 * `groups` are group fill defs (groupFillDef); values[groupKey] is the list of rows.
 * `thumbnailScale` (e.g. 0.25) also returns a PNG of page 1 from the same render.
 */
export async function renderFilled(preparedHtml, defs, values, { fontCoverage = null, label = "fill", thumbnailScale = null, groups = [] } = {}) {
  return renderer.fill(preparedHtml, { values, defs, fontCoverage, groups, thumbnailScale, label });
}
