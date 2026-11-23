// Printable labels (services/label/layout): lays a label page out at its exact
// size and auto-fits it, in the cert-renderer's Chromium (the only process that
// runs a browser). The page comes from label/layout/labelHtml.js: #label is the
// page, #flow its content box, sized by --fs (font size) and --cols (columns).
//
// Fit: the font steps down by `stepPt` from startPt to minPt in one column;
// then the same with 2 (… maxColumns) columns; the first that fits wins. If
// none does, nothing is printed: the report says, per section, how many mm it
// needs beyond the page at the minimum size in one column. Text is never cut
// and never set below minPt.

const PX_PER_MM = 96 / 25.4;

// Runs in the page. → { fits, fontPt, columns, overflowMm, sections: [{ key, status, overflowMm }], tried }
function fitInPage({ startPt, minPt, stepPt, maxColumns }) {
  const flow = document.getElementById("flow");
  const label = document.getElementById("label");
  const pxPerMm = 96 / 25.4;
  const set = (pt, cols) => {
    flow.style.setProperty("--fs", `${pt}pt`);
    flow.style.setProperty("--cols", String(cols));
    void flow.offsetHeight;
  };
  const overflowing = () => flow.scrollHeight > flow.clientHeight + 0.5 || flow.scrollWidth > flow.clientWidth + 0.5;
  const sizes = [];
  for (let pt = startPt; pt >= minPt - 1e-9; pt = Math.round((pt - stepPt) * 100) / 100) sizes.push(pt);
  if (sizes[sizes.length - 1] !== minPt) sizes.push(minPt);
  let tried = 0;
  for (let cols = 1; cols <= maxColumns; cols++) {
    for (const pt of sizes) {
      tried++;
      set(pt, cols);
      if (!overflowing()) {
        return {
          fits: true,
          fontPt: pt,
          columns: cols,
          overflowMm: 0,
          tried,
          sections: [...flow.querySelectorAll(".sec")].map((s) => ({ key: s.dataset.key, status: pt < startPt || cols > 1 ? "reduced" : "fits", overflowMm: 0 })),
        };
      }
    }
  }
  // doesn't fit even at the minimum: measure in one column, the overflow made visible
  set(minPt, 1);
  flow.style.height = "auto";
  const box = flow.getBoundingClientRect();
  const limit = label.getBoundingClientRect().top + label.clientHeight - parseFloat(getComputedStyle(label).paddingBottom);
  const sections = [...flow.querySelectorAll(".sec")].map((s) => {
    const r = s.getBoundingClientRect();
    const over = Math.max(0, Math.min(r.bottom - limit, r.height));
    return { key: s.dataset.key, status: over > 0.5 ? "overflow" : "fits", overflowMm: Math.round((over / pxPerMm) * 10) / 10 };
  });
  return { fits: false, fontPt: minPt, columns: 1, overflowMm: Math.round(((box.bottom - limit) / pxPerMm) * 10) / 10, tried, sections, contentHeightPx: box.bottom - label.getBoundingClientRect().top };
}

/**
 * Runs on a page loaded with a label (labelHtml.buildLabelHtml) — renderOps.labelLayout
 * loads it. opts: { widthMm, heightMm, startPt, minPt, stepPt?, maxColumns, previewScale? }
 * → { fit, pdf: Buffer|null (only when it fits: one page, exactly widthMm × heightMm), png: Buffer (page, + the overflow below it when it doesn't fit) }
 */
export function checkLabelOpts({ widthMm, heightMm, startPt = 9, minPt = 6 }) {
  if (!(widthMm > 0 && heightMm > 0)) throw new Error("widthMm and heightMm are required");
  if (minPt > startPt) throw new Error("minPt is above startPt");
}
export async function layoutLabelOn(page, { widthMm, heightMm, startPt = 9, minPt = 6, stepPt = 0.25, maxColumns = 2, previewScale = 2 }) {
  const fit = await page.evaluate(fitInPage, { startPt, minPt, stepPt, maxColumns });
  const pageW = widthMm * PX_PER_MM;
  const pageH = heightMm * PX_PER_MM;
  const viewport = page.viewport(); // a pooled page: put its viewport back for the next render
  try {
    await page.setViewport({ width: Math.ceil(pageW) + 2, height: Math.ceil(Math.max(pageH, fit.contentHeightPx || 0)) + 2, deviceScaleFactor: previewScale });
    if (!fit.fits) {
      // the page edge as a red dashed line: what is below it would not be on the label
      await page.evaluate((h) => {
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;left:0;top:${h}px;width:100%;border-top:2px dashed #dc2626;z-index:9`;
        document.getElementById("label").appendChild(line);
      }, pageH);
    }
    const shotH = fit.fits ? pageH : Math.max(pageH, fit.contentHeightPx || pageH) + 4;
    await page.bringToFront(); // a background tab may never produce a frame (renderer.js)
    const png = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: pageW, height: shotH }, captureBeyondViewport: true }));
    const pdf = fit.fits
      ? Buffer.from(await page.pdf({ width: `${widthMm}mm`, height: `${heightMm}mm`, margin: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true, preferCSSPageSize: true, pageRanges: "1" }))
      : null;
    return { fit, pdf, png };
  } finally {
    if (viewport) await page.setViewport(viewport).catch(() => {});
  }
}
