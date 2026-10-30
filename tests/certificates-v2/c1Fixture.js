import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** A small catalogue with one page of every kind, drawn with pdf-lib. */
export async function fixtureCatalogue() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = (lines, { drawOnly = false } = {}) => {
    const p = doc.addPage([595, 842]);
    if (drawOnly) p.drawRectangle({ x: 60, y: 200, width: 470, height: 500, color: rgb(0.3, 0.5, 0.7) });
    let y = 780;
    for (const l of lines) {
      const cells = Array.isArray(l) ? l : [l];
      const size = typeof cells[0] === "object" ? cells[0].size : 10;
      cells.forEach((c, i) => p.drawText(typeof c === "object" ? c.t : c, { x: 60 + i * 220, y, size, font }));
      y -= size + 8;
    }
  };
  const product = (name, code) => [
    [{ t: name, size: 34 }],
    "COMPOSITION",
    ["Vitamin E", "200 mg"],
    ["Vitamin A", "100000 I.U."],
    ["Selenium", "0.2 mg"],
    "DOSAGE",
    "1 mL per 2 litres of drinking water for 5 days.",
    "PACKING",
    "1 L bottle",
    ["FORM", "CODE"],
    ["Liquid", code],
  ];
  page([[{ t: "ACME FEED", size: 40 }], "Product catalogue 2026 edition — animal nutrition"]); // 1 cover
  page(["CONTENTS", "Vitaminol ............ 4", "Hepaton ............ 6", "Registrations ............ 9", "Contact ............ 7"]); // 2 contents
  page([]); // 3 blank
  page(product("VITAMINOL", "AC001")); // 4 product
  page(["About us", "Welcome to ACME Feed. Our mission is healthy animals; founded in 1998 in Klang."]); // 5 about
  page(product("HEPATON", "AC002")); // 6 product
  page(["Contact us", "Tel: +60 3 1234 5678", "Fax: +60 3 1234 5679", "info@acme-feed.com", "Address: Lot 5, Jalan Industri, Klang"]); // 7 contact
  page([], { drawOnly: true }); // 8 a scanned page: drawn, no text layer
  page(["Thank you for choosing ACME — www.acme-feed.com"]); // 9 back
  return Buffer.from(await doc.save());
}
