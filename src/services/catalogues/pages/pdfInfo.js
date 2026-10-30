import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CertError } from "../../certificates/errors.js";

// The one look at a catalogue PDF an upload takes: can it be opened, how many
// pages, how big. No text, no drawing, no AI — a person chooses the pages next.

/**
 * buffer → { pageCount, pages: [{ number, width, height }] }
 * A file that can't be used is refused here, before anything is stored or queued.
 * A file locked by an owner password opens but can't be split into readable pages: refused too.
 */
export async function openPdf(buffer) {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") throw passwordProtected();
    throw new CertError("PDF_UNREADABLE", "This file can't be opened as a PDF — it may be damaged. Export it again and upload that copy.", 422);
  }
  try {
    const { info } = await doc.getMetadata();
    if (info?.EncryptFilterName) throw passwordProtected();
    if (!doc.numPages) throw new CertError("PDF_NO_PAGES", "This PDF has no pages.", 422);
    const pages = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const { width, height } = page.getViewport({ scale: 1 });
      pages.push({ number, width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 });
      page.cleanup();
    }
    return { pageCount: pages.length, pages };
  } finally {
    await doc.destroy();
  }
}

const passwordProtected = () => new CertError("PDF_PASSWORD_PROTECTED", "This PDF is password-protected — upload a copy without a password.", 422);
