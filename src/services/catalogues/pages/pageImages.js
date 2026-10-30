import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Page images of a kept catalogue PDF for the "choose pages" step (C1): a small
// thumbnail per page and a larger preview, WebP, rendered by code (pdf.js on
// @napi-rs/canvas — no Chromium, no AI). One page when it is first asked for,
// never the whole PDF. They are a cache, not records: kept under
// uploads/catalogue-pages/{companyId}/{versionId}/ (outside the stored-file tree
// the orphan sweep owns) and re-rendered from the PDF when missing.

export const SIZES = { thumb: 240, large: 1200 };
const ROOT = path.resolve(process.cwd(), "uploads", "catalogue-pages");
const UUID_RE = /^[0-9a-f-]{36}$/i;
// without them a font the PDF doesn't embed (Helvetica, Times…) draws nothing: a page of text renders white
const STANDARD_FONTS = `${path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")).replace(/\\/g, "/")}/standard_fonts/`;

/** pdf.js needs a canvas factory outside the browser */
class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(pair, width, height) {
    pair.canvas.width = width;
    pair.canvas.height = height;
  }
  destroy(pair) {
    pair.canvas.width = 0;
    pair.canvas.height = 0;
  }
}

export function cachePath(companyId, versionId, n, size = "thumb") {
  if (!UUID_RE.test(String(companyId)) || !UUID_RE.test(String(versionId)) || !Number.isInteger(n) || !SIZES[size]) throw new Error("pageImages: bad cache key");
  return path.join(ROOT, companyId, versionId, `${size}-${n}.webp`);
}

/** Renders one page of `buffer` at `size` into the cache. → file path, or null when there is no such page */
export async function renderPage(buffer, { companyId, versionId, n, size = "thumb" }) {
  const doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, standardFontDataUrl: STANDARD_FONTS, canvasFactory: new NapiCanvasFactory() }).promise;
  try {
    if (n < 1 || n > doc.numPages) return null;
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: SIZES[size] / base.width });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const file = cachePath(companyId, versionId, n, size);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await canvas.encode("webp", size === "thumb" ? 72 : 80));
    page.cleanup();
    return file;
  } finally {
    await doc.destroy();
  }
}

// the same page asked for twice at once is rendered once
const rendering = new Map();

/** The cached image of one page, rendered first when missing. → file path */
export async function pageImage(readPdf, { companyId, versionId, n, size = "thumb" }) {
  const file = cachePath(companyId, versionId, n, size);
  if (fs.existsSync(file)) return file;
  if (!rendering.has(file)) {
    rendering.set(file, (async () => renderPage(await readPdf(), { companyId, versionId, n, size }))().finally(() => rendering.delete(file)));
  }
  return rendering.get(file);
}
