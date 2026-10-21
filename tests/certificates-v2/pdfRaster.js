// Rasterises a PDF page the way Chrome's own viewer (PDFium) shows it — the
// viewer the hairline was reported in — and finds ink an exported PDF draws
// on paper the original design leaves blank: the "hairline box around the
// raster signature" check (plan §7.8, I26).
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import puppeteer from "puppeteer";
import { PNG } from "pngjs";

let browser = null;
async function getBrowser() {
  if (!browser) browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--font-render-hinting=none"] });
  return browser;
}

export async function closeRaster() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

/**
 * PDF page 1 → PNG Buffer as Chrome's own viewer (PDFium) draws it at 100 %
 * (1 CSS px per px). The page is cropped out of the viewer.
 */
export async function rasterizePdfium(pdf) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pdfium-")), "page.pdf");
  fs.writeFileSync(file, pdf);
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewport({ width: 1400, height: 1700, deviceScaleFactor: 1 });
    await page.goto(`${pathToFileURL(file).href}#toolbar=0&navpanes=0&zoom=100`, { waitUntil: "load" });
    // the viewer draws asynchronously: wait until two screenshots agree
    let last = null;
    let shot = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      shot = Buffer.from(await page.screenshot({ type: "png" }));
      if (last && shot.equals(last) && i > 2) break;
      last = shot;
    }
    const img = PNG.sync.read(shot);
    // the page = everything that isn't the viewer's background, minus the drop
    // shadow: shrink each edge until that edge line is mostly white
    const px = (x, y) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const bg = px(2, img.height - 3);
    const isBg = (x, y) => px(x, y).every((c, k) => Math.abs(c - bg[k]) <= 12);
    const white = (x, y) => px(x, y).every((c) => c > 245);
    let [x0, y0, x1, y1] = [img.width, img.height, 0, 0];
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if (isBg(x, y)) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x + 1);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y + 1);
      }
    }
    if (x1 <= x0 || y1 <= y0) throw new Error("PDF viewer showed no page");
    const rowWhite = (y) => {
      let n = 0;
      for (let x = x0; x < x1; x++) n += white(x, y);
      return n / (x1 - x0);
    };
    const colWhite = (x) => {
      let n = 0;
      for (let y = y0; y < y1; y++) n += white(x, y);
      return n / (y1 - y0);
    };
    while (y1 - y0 > 10 && rowWhite(y0) < 0.6) y0++;
    while (y1 - y0 > 10 && rowWhite(y1 - 1) < 0.6) y1--;
    while (x1 - x0 > 10 && colWhite(x0) < 0.6) x0++;
    while (x1 - x0 > 10 && colWhite(x1 - 1) < 0.6) x1--;
    const out = new PNG({ width: x1 - x0, height: y1 - y0 });
    PNG.bitblt(img, out, x0, y0, x1 - x0, y1 - y0, 0, 0);
    return PNG.sync.write(out);
  } finally {
    await page.close().catch(() => {});
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Ink `testPng` draws on paper that is blank in `refPng`: a pixel counts when
 * the reference is blank (luminance ≥ `paper`) everywhere within 1 px and the
 * test pixel is more than `darker` below it. Rules, fills and text have ink
 * next to them in the reference, so renderers antialiasing them differently
 * never count; a hairline that isn't in the design does. Reported as the
 * longest straight run — a hairline box is a long horizontal/vertical run.
 * → { longestH, longestV, at: { x, y, dir } }
 */
export function extraInk(testPng, refPng, { paper = 230, darker = 12 } = {}) {
  const a = PNG.sync.read(testPng);
  const b = PNG.sync.read(refPng);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const added = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let refMin = 255; // the darkest reference pixel within 1 px
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
          refMin = Math.min(refMin, lum(b.data, (yy * b.width + xx) * 4));
        }
      }
      if (refMin >= paper && refMin - lum(a.data, (y * a.width + x) * 4) > darker) added[y * w + x] = 1;
    }
  }
  const best = { longestH: 0, longestV: 0, at: null };
  let top = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0, run = 0; x < w; x++) {
      run = added[y * w + x] ? run + 1 : 0;
      best.longestH = Math.max(best.longestH, run);
      if (run > top) (top = run), (best.at = { x: x - run + 1, y, dir: "h" });
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0, run = 0; y < h; y++) {
      run = added[y * w + x] ? run + 1 : 0;
      best.longestV = Math.max(best.longestV, run);
      if (run > top) (top = run), (best.at = { x, y: y - run + 1, dir: "v" });
    }
  }
  return best;
}
