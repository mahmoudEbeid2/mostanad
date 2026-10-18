// Certificates V2 — LIVE invoice extraction check (plan §16.1, §17 Phase 3
// exit criterion "real invoices extracted"). Calls the real Gemini API, so it
// is opt-in and never part of `npm test`:
//
//   GEMINI_LIVE=1 node tests/live/certificates.invoice_extract.live.mjs
//
// For every fixtures/certificates/invoice_*.{pdf,png,jpg,webp} with a sibling
// invoice_*.expected.json it extracts the file and compares field by field:
//   { "header": { "invoiceNumber": "…", "invoiceDate": "15/04/2026", … },
//     "items": [ { "lineNo": 1, "name": "…", "batchNo": "…", "expiryDate": "06/2027", "quantity": 400, … } ] }
// Dates compare on the raw printed text; only the keys present in the
// expectation are checked. One Gemini call per invoice (free tier: 8 RPM).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { extractInvoice } from "../../src/services/certificates/invoices/invoiceExtractor.js";
import { detectInvoiceFormat } from "../../src/services/certificates/invoices/invoiceService.js";

if (process.env.GEMINI_LIVE !== "1" || process.env.GEMINI_DISABLED === "true") {
  console.error("Opt-in only: set GEMINI_LIVE=1 (and not GEMINI_DISABLED) to call the real API.");
  process.exit(2);
}

const DIR = path.join(process.cwd(), "fixtures", "certificates");
const files = fs.readdirSync(DIR).filter((f) => /^invoice_.*\.(pdf|png|jpe?g|webp)$/i.test(f));
const cases = files.map((f) => ({ file: f, expected: path.join(DIR, f.replace(/\.[^.]+$/, ".expected.json")) })).filter((c) => fs.existsSync(c.expected));
if (!cases.length) {
  console.error(`No invoice_*.{pdf,png,jpg,webp} + invoice_*.expected.json pairs in ${DIR}.`);
  process.exit(2);
}

const shown = (v) => (v && typeof v === "object" && "raw" in v ? v.raw : v);
const same = (a, b) => String(shown(a) ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
let checked = 0;
let wrong = 0;

for (const c of cases) {
  const buffer = fs.readFileSync(path.join(DIR, c.file));
  const expected = JSON.parse(fs.readFileSync(c.expected, "utf8"));
  console.log(`\n🧾 ${c.file}`);
  const out = await extractInvoice(buffer, detectInvoiceFormat(buffer).mimeType);
  console.log(`   ${out.provenance.modelId} · ${out.provenance.ms} ms · ${out.items.length} lines · warnings: ${out.provenance.warnings.join("; ") || "none"}`);
  const report = (where, key, exp, got) => {
    checked++;
    if (same(got, exp)) return;
    wrong++;
    console.log(`   ❌ ${where}.${key}: expected "${exp}", got "${shown(got) ?? ""}"`);
  };
  for (const [k, v] of Object.entries(expected.header || {})) report("header", k, v, out.header[k]);
  const items = expected.items || [];
  if (items.length !== out.items.length) {
    wrong++;
    console.log(`   ❌ line count: expected ${items.length}, got ${out.items.length}`);
  }
  for (const exp of items) {
    const got = out.items.find((i) => i.lineNo === exp.lineNo);
    if (!got) {
      wrong++;
      console.log(`   ❌ line ${exp.lineNo} missing`);
      continue;
    }
    for (const [k, v] of Object.entries(exp)) if (k !== "lineNo") report(`line ${exp.lineNo}`, k, v, k === "quantity" ? got.data.quantity : got.data[k]);
  }
}

console.log(`\n📊 ${checked - wrong}/${checked} values correct across ${cases.length} invoice(s)`);
process.exit(wrong ? 1 : 0);
