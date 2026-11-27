import * as renderer from "./renderer.js";
import { planGlyphs } from "./glyphPlan.js";
import { fallbackFontCss } from "./fallbackFaces.js";
import { checkLabelOpts, layoutLabelOn } from "./labelFit.js";

// Composite operations that need several engine calls on ONE loaded document.
// They used to be closures passed to renderer.withDocument() by prepareEngine
// and fieldService; a closure can't cross the HTTP boundary to the
// cert-renderer service (plan §5.3), so each one is named here and runs inside
// the service. The bodies are the former closures, unchanged.

/** Decides how each value character is drawn and loads the fallback faces it needs → the plan for fill. */
async function loadGlyphPlan(page, { companyFontData = null, ...opts }) {
  const plan = planGlyphs(opts);
  if (plan?.faces.length) await renderer.engine(page, "addFallbackFonts", await fallbackFontCss(plan.faces, { companyFontData }), plan.faces.map(({ name, chars }) => ({ name, chars })));
  return plan;
}

/** prepare step 1 (§7.3, §7.8): detect groups, clear every field, remove placeholder rows → { results, detected, html } */
export const prepareClear = (html, { inspectDefs = [], clearFields }) =>
  renderer.withDocument(
    html,
    async (page) => {
      const detected = inspectDefs.length ? await renderer.engine(page, "inspectGroups", inspectDefs) : {};
      const { results } = await renderer.engine(page, "clear", clearFields);
      const okGeo = Object.fromEntries(Object.entries(detected).filter(([, g]) => g.ok));
      if (Object.keys(okGeo).length) await renderer.engine(page, "removeGroupPlaceholders", okGeo);
      const out = await renderer.serialize(page);
      return { results, detected, html: out };
    },
    { label: "prepare:clear" }
  );

/** prepare step 2 (§7.5): refill with the samples, measure, screenshot → { fill, rects, shots } */
export const prepareRoundTrip = (html, { samples, defs, fontCoverage = null, fontFallbacks = null, companyFontData = null, groupDefs = [], measureKeys }) =>
  renderer.withDocument(
    html,
    async (page) => {
      const plan = await loadGlyphPlan(page, { values: samples, defs, groups: groupDefs, fontCoverage, fontFallbacks, companyFontData });
      const fill = await renderer.engine(page, "fill", samples, defs, fontCoverage, groupDefs, plan);
      const rects = await renderer.engine(page, "measure", measureKeys);
      const shots = await renderer.screenshotPagesOf(page);
      return { fill, rects, shots };
    },
    { label: "prepare:roundtrip" }
  );

/** fill a prepared document (§7.4, §7.8); `remove`: fields whose row is taken off (28 Nov) → { html, flags, geometry, thumbnail, rows } */
export const fill = (html, { values, defs, fontCoverage = null, fontFallbacks = null, companyFontData = null, groups = [], remove = [], thumbnailScale = null, label = "fill" }) =>
  renderer.withDocument(
    html,
    async (page) => {
      const plan = await loadGlyphPlan(page, { values, defs, groups, fontCoverage, fontFallbacks, companyFontData });
      const res = await renderer.engine(page, "fill", values, defs, fontCoverage, groups, plan);
      const rows = remove.length ? await renderer.engine(page, "removeRows", remove) : { removed: {}, failed: [] };
      const out = await renderer.serialize(page);
      const thumbnail = thumbnailScale ? (await renderer.screenshotPagesOf(page, { scale: thumbnailScale }))[0]?.png || null : null;
      return { html: out, flags: res.flags, geometry: res.geometry, thumbnail, rows };
    },
    { label }
  );

/** measure fields and detect groups without mutation (§8.2) → { fields, groups, lineCells? } (lineCells: template repair) */
export const inspect = (html, { fields, inspectDefs = [], lineCells = false }) =>
  renderer.withDocument(
    html,
    async (page) => ({
      fields: fields?.length ? await renderer.engine(page, "inspect", fields) : {},
      groups: inspectDefs.length ? await renderer.engine(page, "inspectGroups", inspectDefs) : {},
      ...(lineCells ? { lineCells: await renderer.engine(page, "lineCells") } : {}),
    }),
    { label: "fields:inspect" }
  );

/** Printable label (engine/labelFit.js): auto-fit at the exact page size → { fit, pdf|null, png } */
export const labelLayout = (html, opts = {}) => {
  checkLabelOpts(opts);
  return renderer.withDocument(html, (page) => layoutLabelOn(page, opts), { label: "label-layout", media: "print" });
};
