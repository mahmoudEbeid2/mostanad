import { PDFDocument } from "pdf-lib";

// The catalogue cut down to the pages a person kept (C1), on the server, before
// anything is read for the AI. Page i of the split file is original page
// pageMap[i] — every block read from it is stored under its ORIGINAL number,
// so evidence reads "Catalogue p.7" whatever the split file's numbering.

/** Ascending, distinct integers. */
export const normalisePages = (pages) => [...new Set(pages.map(Number))].sort((a, b) => a - b);

/** buffer + original page numbers → { buffer, pageMap } (pages in the original order) */
export async function splitPdf(buffer, pages) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const pageMap = normalisePages(pages);
  if (!pageMap.length || pageMap.some((n) => !Number.isInteger(n) || n < 1 || n > total)) throw new RangeError(`splitPdf: pages must be within 1..${total}`);
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(src, pageMap.map((n) => n - 1));
  for (const p of copied) out.addPage(p);
  return { buffer: Buffer.from(await out.save({ useObjectStreams: true })), pageMap };
}
