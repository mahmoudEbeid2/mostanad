import crypto from "crypto";
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

const rc4 = (key, data) => {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  let j = 0;
  return Buffer.from(data.map((b) => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    return b ^ s[(s[i] + s[j]) & 255];
  }));
};

/**
 * A one-page PDF under the standard security handler (40-bit RC4, revision 2), written by hand:
 * userPassword "" opens without a password (locked by its owner only), anything else asks for it.
 */
export function encryptedPdf(userPassword) {
  const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
  const padded = Buffer.concat([Buffer.from(userPassword, "latin1"), PAD]).subarray(0, 32);
  const O = Buffer.alloc(32, 0x41);
  const P = Buffer.alloc(4);
  P.writeInt32LE(-44);
  const ID = Buffer.alloc(16, 0x42);
  const key = crypto.createHash("md5").update(Buffer.concat([padded, O, P, ID])).digest().subarray(0, 5);
  const U = rc4(key, [...PAD]);
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P -44 >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = bodies.map((b, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 5\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<${ID.toString("hex")}> <${ID.toString("hex")}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
