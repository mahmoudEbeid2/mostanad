// The real files of the auto-intake test folder (labels, certificates, invoice,
// manufacturing order, catalogues — 177 MB) are too large for the repository. This
// keeps what classification reads from each one — name, size, hash, page count and
// the start of every page's text layer — in fixtures/intake/samples.json, which the
// tests use. Rerun it when the folder changes:
//   node scripts/intakeFixtures.js "C:\Users\A Store\Desktop\New folder"
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { readPages } from "../src/services/intake/intakeText.js";

const dir = process.argv[2] || process.env.INTAKE_FIXTURE_DIR;
if (!dir || !fs.existsSync(dir)) {
  console.error("Usage: node scripts/intakeFixtures.js <folder>");
  process.exit(1);
}
const out = [];
for (const name of fs.readdirSync(dir).sort()) {
  const full = path.join(dir, name);
  if (!fs.statSync(full).isFile()) continue;
  const buffer = fs.readFileSync(full);
  const sample = { name, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), magic: buffer.subarray(0, 4).toString("latin1") };
  try {
    const { pages, pageCount } = await readPages(buffer, { maxPages: 40, maxChars: 1500 });
    Object.assign(sample, { pageCount, pages });
  } catch (err) {
    sample.error = err.message;
  }
  out.push(sample);
  console.log(`${name}: ${sample.pageCount ?? "-"} pages`);
}
const file = path.join(process.cwd(), "fixtures", "intake", "samples.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n${out.length} files → ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
process.exit(0);
