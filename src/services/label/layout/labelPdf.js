import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// PDF helpers for printable labels: the exact page size, the sizes of the text
// actually in a PDF, and "keep the original design, just scale".

export const PT_PER_MM = 72 / 25.4;
export const mmOf = (pt) => Math.round((pt / PT_PER_MM) * 100) / 100;

/**
 * Chromium sizes a PDF page in whole device pixels (100 mm comes out 99.82 mm).
 * Sets the first page's MediaBox/CropBox to exactly widthMm × heightMm, keeping
 * the content's top-left where it is (the difference, < 0.3 mm, is blank paper
 * at the right/bottom edge). → Buffer
 */
export async function exactPageSize(pdf, widthMm, heightMm) {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(0);
  const { x, y, height } = page.getMediaBox();
  const W = widthMm * PT_PER_MM;
  const H = heightMm * PT_PER_MM;
  const top = y + height;
  page.setMediaBox(x, top - H, W, H);
  page.setCropBox(x, top - H, W, H);
  return Buffer.from(await doc.save());
}

/** → { pages, widthMm, heightMm } of page 1 (MediaBox) */
export async function pageSizeMm(pdf) {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const box = doc.getPage(0).getMediaBox();
  return { pages: doc.getPageCount(), widthMm: mmOf(box.width), heightMm: mmOf(box.height) };
}

/**
 * The text layer's font sizes, in pt as printed (the text matrix's scale).
 * → { runs, smallestPt, sizes: [pt…] (distinct, ascending) } — runs 0 when the PDF has no text layer.
 */
export async function textSizes(pdf, { page: n = 1 } = {}) {
  const doc = await getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const sizes = [];
    for (const it of content.items) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      const [a, b, c, d] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b);
      if (size > 0) sizes.push(Math.round(size * 100) / 100);
    }
    page.cleanup();
    return { runs: sizes.length, smallestPt: sizes.length ? Math.min(...sizes) : null, sizes: [...new Set(sizes)].sort((x, y) => x - y) };
  } finally {
    await doc.destroy();
  }
}

/**
 * "Keep the original design, just scale": the uploaded label (PDF page 1, PNG or
 * JPEG) on a new page of exactly widthMm × heightMm.
 *   fit (default) — proportions kept, centred, white where the aspect ratio differs
 *   stretch       — fills the page; distorts the text (the caller warns)
 * → { pdf, scaleX, scaleY, scalePct, source: { widthMm, heightMm, kind }, smallestTextPt|null, textMeasurable }
 */
export async function scaleToPage(buffer, mimeType, { widthMm, heightMm, stretch = false }) {
  const out = await PDFDocument.create();
  const W = widthMm * PT_PER_MM;
  const H = heightMm * PT_PER_MM;
  const page = out.addPage([W, H]);
  let srcW;
  let srcH;
  let draw;
  let smallestSourcePt = null;
  if (mimeType === "application/pdf") {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    if (!src.getPageCount()) throw Object.assign(new Error("The PDF has no page"), { statusCode: 400 });
    const [embedded] = await out.embedPdf(src, [0]);
    ({ width: srcW, height: srcH } = embedded);
    draw = (opts) => page.drawPage(embedded, opts);
    smallestSourcePt = (await textSizes(buffer)).smallestPt;
  } else if (mimeType === "image/png" || mimeType === "image/jpeg") {
    const img = mimeType === "image/png" ? await out.embedPng(buffer) : await out.embedJpg(buffer);
    ({ width: srcW, height: srcH } = img);
    draw = (opts) => page.drawImage(img, opts);
  } else {
    throw Object.assign(new Error("Scale works on a PDF, PNG or JPEG label"), { statusCode: 400 });
  }
  let sx = W / srcW;
  let sy = H / srcH;
  if (!stretch) sx = sy = Math.min(sx, sy);
  const w = srcW * sx;
  const h = srcH * sy;
  draw({ x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  const pdf = Buffer.from(await out.save());
  // an image has no physical size: its "mm" is at 96 dpi, for display only
  const unit = mimeType === "application/pdf" ? 1 / PT_PER_MM : 25.4 / 96;
  return {
    pdf,
    scaleX: sx,
    scaleY: sy,
    // for an image the scale is against its 96-dpi size, so it's not a print scale: shown as the fit only
    scalePct: mimeType === "application/pdf" ? Math.round(Math.min(sx, sy) * 1000) / 10 : null,
    source: { kind: mimeType === "application/pdf" ? "pdf" : "image", widthMm: Math.round(srcW * unit * 10) / 10, heightMm: Math.round(srcH * unit * 10) / 10 },
    // text scales with the smaller factor (vertical size for stretch)
    smallestTextPt: smallestSourcePt === null ? null : Math.round(smallestSourcePt * (stretch ? sy : sx) * 100) / 100,
    textMeasurable: mimeType === "application/pdf" && smallestSourcePt !== null,
  };
}
