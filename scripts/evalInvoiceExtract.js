import "dotenv/config";
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Live invoice extraction eval (2026-11-23, model choice): the three golden
// invoices (fixtures/certificates/invoices/INV_*.json) printed to PDF from their
// own text, read by the real model (INVOICE_EXTRACT), scored field by field
// against the golden header and lines. Opt-in and paid: RUN_LIVE_GEMINI=1.
// Three calls. No database.
//
//   RUN_LIVE_GEMINI=1 node scripts/evalInvoiceExtract.js [--out file.json]

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
process.env.GEMINI_DISABLED = "false";
const { extractInvoice } = await import("../src/services/certificates/invoices/invoiceExtractor.js");
const { MODELS } = await import("../src/services/ai/modelRegistry.js");

const DIR = path.join(process.cwd(), "fixtures", "certificates", "invoices");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(process.cwd(), "golden", `ai-eval-invoice-extract-${new Date().toISOString().slice(0, 10)}.json`);
const ascii = (t) => t.replace(/[·•]/g, "-").replace(/[–—]/g, "-").replace(/[^\x20-\x7E\n]/g, "?");

async function toPdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageText of text.split(/=== Page \d+ ===\n?/).filter((p) => p.trim())) {
    const page = doc.addPage([842, 595]);
    let y = 560;
    for (const line of ascii(pageText).split("\n")) {
      page.drawText(line.slice(0, 160), { x: 30, y, size: 9, font });
      y -= 14;
    }
  }
  return Buffer.from(await doc.save());
}
const raw = (v) => (v && typeof v === "object" && "raw" in v ? v.raw : v);
const same = (a, b) => String(raw(a) ?? "").trim().toLowerCase() === String(raw(b) ?? "").trim().toLowerCase();

const card = { date: new Date().toISOString(), model: MODELS.INVOICE_EXTRACT.id, invoices: [], totals: {} };
let checked = 0;
let right = 0;
for (const name of ["INV_A", "INV_B", "INV_C"]) {
  const g = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8"));
  const pdf = await toPdf(g.textContent);
  const t0 = Date.now();
  const row = { invoice: name, fields: [], error: null, ms: 0 };
  try {
    const out = await extractInvoice(pdf, "application/pdf");
    row.ms = Date.now() - t0;
    const want = [
      ["header.invoiceNumber", g.header.invoiceNumber, out.header?.invoiceNumber],
      ["header.invoiceDate", g.header.invoiceDate, out.header?.invoiceDate],
      ...g.lines.flatMap((l, i) => [
        [`line${i + 1}.batchNo`, l.data.batchNo, out.items?.[i]?.data?.batchNo],
        [`line${i + 1}.expiryDate`, l.data.expiryDate, out.items?.[i]?.data?.expiryDate],
        [`line${i + 1}.quantity`, l.data.quantity, out.items?.[i]?.data?.quantity],
      ]),
    ].filter(([, w]) => w !== null && w !== undefined);
    for (const [field, w, got] of want) {
      const ok = same(w, got);
      checked++;
      if (ok) right++;
      row.fields.push({ field, expected: raw(w), got: raw(got) ?? null, ok });
    }
  } catch (err) {
    row.ms = Date.now() - t0;
    row.error = err.message;
  }
  card.invoices.push(row);
  console.log(`${name}: ${row.error ? `ERROR ${row.error}` : `${row.fields.filter((f) => f.ok).length}/${row.fields.length} fields`} · ${row.ms} ms`);
}
card.totals = { fieldsRight: right, fieldsChecked: checked, accuracy: checked ? right / checked : null, failedCalls: card.invoices.filter((i) => i.error).length, avgMs: Math.round(card.invoices.reduce((a, i) => a + i.ms, 0) / card.invoices.length) };
console.log(`\naccuracy ${right}/${checked} · ${card.totals.failedCalls} failed · avg ${card.totals.avgMs} ms`);
fs.writeFileSync(OUT, JSON.stringify(card, null, 2));
