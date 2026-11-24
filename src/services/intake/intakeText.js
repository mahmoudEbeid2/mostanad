import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

// The text layer of a dropped PDF (or a PDF-compatible .ai), page by page — what
// the intake rules read. No AI. A page with no text (a scan, outlined artwork)
// comes back empty; the classifier then knows the text can't decide.

/** buffer → { pageCount, pages: [{ n, text }] } — the first `maxPages`, each cut to `maxChars`. */
export async function readPages(buffer, { maxPages = 40, maxChars = 4000 } = {}) {
  const doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const text = content.items
        .map((it) => (typeof it.str === "string" ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ n, text: text.slice(0, maxChars) });
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

/** Pages `from`..`to` (1-based, inclusive) of a PDF as a PDF of their own — one document of a split bundle. */
export async function extractPages(buffer, from, to = from) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const indices = [];
  for (let i = from - 1; i <= Math.min(to, src.getPageCount()) - 1; i++) indices.push(i);
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  return Buffer.from(await out.save());
}
