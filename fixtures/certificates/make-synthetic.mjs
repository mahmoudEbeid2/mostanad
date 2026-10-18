// Regenerates the synthetic Certificates V2 fixtures (CERTIFICATES_V2_PLAN.md §16.1):
//   no_pdf_content.ai   — an Illustrator file saved WITHOUT "Create PDF Compatible File"
//                         (PostScript-only, no %PDF- header) → 422 NO_PDF_CONTENT
//   outlined_text.pdf   — a page whose "text" is vector outlines only → NO_LIVE_TEXT
// The golden templates (ADDVET_COA.ai, PHARMAVET_COA.pdf) and malicious.html are
// checked in as-is. Run: node fixtures/certificates/make-synthetic.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, rgb } from "pdf-lib";

const dir = path.dirname(fileURLToPath(import.meta.url));

fs.writeFileSync(
  path.join(dir, "no_pdf_content.ai"),
  [
    "%!PS-Adobe-3.0 ",
    "%%Creator: Adobe Illustrator(R) 30.6",
    "%%AI8_CreatorVersion: 30.6.0",
    "%%For: (synthetic fixture)",
    "%%Title: (no_pdf_content.ai)",
    "%%BoundingBox: 0 0 595 842",
    "%%EndComments",
    "%AI5_FileFormat 14.0",
    "%%EOF",
    "",
  ].join("\n")
);

const doc = await PDFDocument.create();
const page = doc.addPage([595.28, 841.89]);
// "CERTIFICATE" drawn as outlines: rectangles and an SVG path — no text objects.
page.drawRectangle({ x: 60, y: 760, width: 475, height: 2, color: rgb(0.1, 0.1, 0.1) });
page.drawSvgPath("M 0 0 L 10 0 L 10 30 L 0 30 Z M 15 0 L 35 0 L 35 6 L 21 6 L 21 12 L 33 12 L 33 18 L 21 18 L 21 24 L 35 24 L 35 30 L 15 30 Z", {
  x: 60,
  y: 740,
  color: rgb(0, 0, 0),
});
page.drawCircle({ x: 300, y: 420, size: 40, borderColor: rgb(0.2, 0.4, 0.7), borderWidth: 3 });
fs.writeFileSync(path.join(dir, "outlined_text.pdf"), await doc.save({ useObjectStreams: false }));

console.log("wrote no_pdf_content.ai, outlined_text.pdf");
