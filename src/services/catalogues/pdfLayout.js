import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// The text layer of a catalogue PDF with positions (plan.md §15.3 step 1).
// Items are kept in the PDF's content-stream order: InDesign writes one text
// frame after another, each in reading order, with a table row's name and value
// next to each other ("Vitamin E" "200.000 mg"). A geometric re-flow (pdftotext
// -layout) splits those rows across columns, so the stream order is the one we keep.
// Coordinates are PDF points with a top-left origin.

/** buffer → { pages: [{ n, width, height, items: [{ s, x, y, w, h }] }] } */
export async function readPdfLayout(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        const s = typeof it.str === "string" ? it.str.trim() : "";
        if (!s) continue;
        const [a, b, c, d, e, f] = it.transform;
        const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 0;
        // the run's axis-aligned box, also for rotated text (a side tab set at 90°)
        const angle = Math.atan2(b, a);
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
        const run = it.width || 0;
        const xs = [e, e + cos * run, e - sin * size, e + cos * run - sin * size];
        const ys = [f, f + sin * run, f + cos * size, f + sin * run + cos * size];
        const left = clamp(Math.min(...xs), 0, width);
        const right = clamp(Math.max(...xs), 0, width);
        const top = clamp(height - Math.max(...ys), 0, height);
        const bottom = clamp(height - Math.min(...ys), 0, height);
        const rotated = Math.abs(sin) > 0.01;
        // a horizontal run's h is its font size (titles are found by it); a rotated run's h is its extent
        items.push({ s, x: round(left), y: round(top), w: round(right - left), h: round(rotated ? bottom - top : size), ...(rotated ? { r: 1 } : {}) });
      }
      pages.push({ n, width: round(width), height: round(height), items });
      page.cleanup();
    }
    return { pages };
  } finally {
    await doc.destroy();
  }
}

const round = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
