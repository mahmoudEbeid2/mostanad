import pixelmatch from "pixelmatch";
import { createCanvas, loadImage } from "@napi-rs/canvas";

async function rgba(png) {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
}

/**
 * Pixel comparison of two PNGs (plan §7.5). Images of different size are
 * compared over their common area and the size mismatch is reported.
 * → { diffPixels, totalPixels, pct, sizeMismatch, diffPng }
 */
export async function comparePngs(pngA, pngB, { threshold = 0.1 } = {}) {
  const [a, b] = await Promise.all([rgba(pngA), rgba(pngB)]);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const crop = (img) => {
    if (img.width === width && img.height === height) return img.data;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + width * 4), y * width * 4);
    return out;
  };
  const diff = createCanvas(width, height);
  const dctx = diff.getContext("2d");
  const diffImage = dctx.createImageData(width, height);
  const diffPixels = pixelmatch(crop(a), crop(b), diffImage.data, width, height, { threshold });
  dctx.putImageData(diffImage, 0, 0);
  const totalPixels = width * height;
  return {
    diffPixels,
    totalPixels,
    pct: totalPixels ? (diffPixels / totalPixels) * 100 : 0,
    sizeMismatch: a.width !== b.width || a.height !== b.height,
    diffPng: diff.toBuffer("image/png"),
  };
}
