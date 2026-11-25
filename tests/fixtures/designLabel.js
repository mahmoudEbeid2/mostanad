import zlib from "node:zlib";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// A small designed label for the "keep the design" resize tests (CI has no client
// files): 100 × 150 mm, a green band across the top with the product name, a round
// logo (curves) and a photo (PNG) at the top right, a paragraph, a two-column
// composition table, and a grey band at the bottom with the batch line. Its words,
// numbers and units are the ones the tests compare after resizing.

const PT = 72 / 25.4;
export const DESIGN_WORDS_SAMPLE = ["H-DURIN", "Composition", "60,000", "mg", "MADADD02610007", "10/2026"];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** A w × h RGB PNG: a diagonal gradient (so a distortion would show). */
export function gradientPng(w = 60, h = 40) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((255 * x) / w);
      raw[o + 1] = Math.round((255 * y) / h);
      raw[o + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** → Buffer: the designed label PDF (fonts embedded, so its text can be re-set in the same font). */
export async function designedLabelPdf() {
  const doc = await PDFDocument.create();
  const W = 100 * PT;
  const H = 150 * PT;
  const page = doc.addPage([W, H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const top = (mm) => H - mm * PT; // y from the top, in mm
  // bands
  page.drawRectangle({ x: 0, y: top(28), width: W, height: 28 * PT, color: rgb(0.48, 0.7, 0.2) });
  page.drawRectangle({ x: 0, y: 0, width: W, height: 14 * PT, color: rgb(0.85, 0.85, 0.85) });
  // product name on the band
  page.drawText("H-DURIN", { x: 6 * PT, y: top(14), size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Herbal kidney support", { x: 6 * PT, y: top(21), size: 9, font: regular, color: rgb(1, 1, 1) });
  // logo (curves) and a photo
  page.drawEllipse({ x: 86 * PT, y: top(13), xScale: 8 * PT, yScale: 8 * PT, color: rgb(1, 1, 1), borderColor: rgb(0.2, 0.4, 0.1), borderWidth: 1.5 });
  page.drawEllipse({ x: 86 * PT, y: top(13), xScale: 4 * PT, yScale: 4 * PT, color: rgb(0.48, 0.7, 0.2) });
  const img = await doc.embedPng(gradientPng());
  page.drawImage(img, { x: 64 * PT, y: top(58), width: 30 * PT, height: 20 * PT });
  // paragraph
  const para = [
    "Maintains optimal kidney health and natural",
    "diuresis, removes metabolic wastes and",
    "supports recovery after heat stress.",
  ];
  page.drawText("Indications", { x: 6 * PT, y: top(36), size: 9, font: bold, color: rgb(0.48, 0.7, 0.2) });
  para.forEach((l, i) => page.drawText(l, { x: 6 * PT, y: top(41 + i * 4), size: 7, font: regular, color: rgb(0.1, 0.1, 0.1) }));
  // composition: a two-column table (name … amount)
  page.drawText("Composition", { x: 6 * PT, y: top(66), size: 9, font: bold, color: rgb(0.48, 0.7, 0.2) });
  const rows = [
    ["Ammonium Chloride", "60,000 mg"],
    ["Vitamin C", "10,000 mg"],
    ["Potassium Chloride", "10,000 mg"],
    ["Sorbitol", "100,000 mg"],
    ["Distilled water up to", "1,000 mL"],
  ];
  rows.forEach(([n, v], i) => {
    page.drawText(n, { x: 6 * PT, y: top(71 + i * 4), size: 7, font: regular });
    page.drawText(v, { x: 60 * PT, y: top(71 + i * 4), size: 7, font: regular });
  });
  page.drawText("Dosage: 1 ml per 2 litres of drinking water for 3-5 days.", { x: 6 * PT, y: top(99), size: 7, font: regular });
  // bottom band: batch line
  page.drawText("Batch No.: MADADD02610007 | Prod. Date: 10/2026 | Exp. Date: 10/2029", { x: 5 * PT, y: 6 * PT, size: 6.5, font: regular });
  return Buffer.from(await doc.save());
}
