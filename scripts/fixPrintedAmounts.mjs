// One-off, idempotent (27 Nov, acceptance #3). Until 9b49871+1 the rules reader rebuilt each ingredient
// amount as "figure unit", so ADDHEPA's printed "2%" was stored as "2 %". For every product whose
// composition came from a document page, that page is read again with the fixed reader, and an amount that
// differs from the printed one ONLY in spacing takes the printed form. Nothing else changes; a composition a
// person typed (no file) is never touched.
//   node scripts/fixPrintedAmounts.mjs            dry run: lists what would change
//   node scripts/fixPrintedAmounts.mjs --apply    writes it
import { prisma } from "../src/lib/prisma.js";
import { compositionFrom } from "../src/services/intake/intakeRules.js";
import { readPages } from "../src/services/intake/intakeText.js";
import * as fileStore from "../src/services/certificates/storage/fileStore.js";

const APPLY = process.argv.includes("--apply");
const tight = (s) => String(s ?? "").replace(/\s+/g, "");
const products = await prisma.product.findMany({ where: { activeIngredients: { not: null } }, select: { id: true, name: true, companyId: true, activeIngredients: true, fieldProvenance: true } });
const pageText = new Map();
let changed = 0;
for (const p of products) {
  const prov = p.fieldProvenance?.activeIngredients;
  const rows = Array.isArray(p.activeIngredients) ? p.activeIngredients : [];
  if (!prov || (!prov.fileId && !prov.quote) || !rows.length) continue;
  let text = prov.quote || "";
  if (prov.fileId && prov.page) {
    const key = `${prov.fileId}|${prov.page}`;
    if (!pageText.has(key)) {
      try {
        const { pages } = await readPages((await fileStore.readFile(prov.fileId)).buffer, { maxPages: 60, maxChars: 8000 });
        pageText.set(key, pages.find((x) => x.n === prov.page)?.text || "");
      } catch {
        pageText.set(key, "");
      }
    }
    text = pageText.get(key) || text;
  }
  const printed = compositionFrom(text)?.ingredients || [];
  const fixes = [];
  const next = rows.map((r, i) => {
    const q = printed[i];
    const cur = r.amountRaw ?? r.concentration;
    if (!q || tight(q.name).toLowerCase() !== tight(r.name).toLowerCase() || !cur || q.amountRaw === cur || tight(q.amountRaw) !== tight(cur)) return r;
    fixes.push(`${r.name}: "${cur}" → "${q.amountRaw}"`);
    return { ...r, amountRaw: q.amountRaw, concentration: q.amountRaw };
  });
  if (!fixes.length) continue;
  changed++;
  console.log(`${p.name} (${p.id.slice(0, 8)}, ${prov.file || "quote"} p${prov.page ?? "?"}): ${fixes.join("; ")}`);
  if (APPLY) await prisma.product.update({ where: { id: p.id }, data: { activeIngredients: next } });
}
console.log(`${changed} product(s) ${APPLY ? "corrected" : "would be corrected (dry run — add --apply)"}`);
await prisma.$disconnect();
process.exit(0);
