import * as renderer from "./renderer.js";

// Composite operations that need several engine calls on ONE loaded document.
// They used to be closures passed to renderer.withDocument() by prepareEngine
// and fieldService; a closure can't cross the HTTP boundary to the
// cert-renderer service (plan §5.3), so each one is named here and runs inside
// the service. The bodies are the former closures, unchanged.

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
export const prepareRoundTrip = (html, { samples, defs, fontCoverage = null, groupDefs = [], measureKeys }) =>
  renderer.withDocument(
    html,
    async (page) => {
      const fill = await renderer.engine(page, "fill", samples, defs, fontCoverage, groupDefs);
      const rects = await renderer.engine(page, "measure", measureKeys);
      const shots = await renderer.screenshotPagesOf(page);
      return { fill, rects, shots };
    },
    { label: "prepare:roundtrip" }
  );

/** fill a prepared document (§7.4, §7.8) → { html, flags, geometry, thumbnail } */
export const fill = (html, { values, defs, fontCoverage = null, groups = [], thumbnailScale = null, label = "fill" }) =>
  renderer.withDocument(
    html,
    async (page) => {
      const res = await renderer.engine(page, "fill", values, defs, fontCoverage, groups);
      const out = await renderer.serialize(page);
      const thumbnail = thumbnailScale ? (await renderer.screenshotPagesOf(page, { scale: thumbnailScale }))[0]?.png || null : null;
      return { html: out, flags: res.flags, geometry: res.geometry, thumbnail };
    },
    { label }
  );

/** measure fields and detect groups without mutation (§8.2) → { fields, groups } */
export const inspect = (html, { fields, inspectDefs = [] }) =>
  renderer.withDocument(
    html,
    async (page) => ({
      fields: await renderer.engine(page, "inspect", fields),
      groups: inspectDefs.length ? await renderer.engine(page, "inspectGroups", inspectDefs) : {},
    }),
    { label: "fields:inspect" }
  );
