// One-off: matches a shipped font to every font of the template versions converted
// before fontFallbacks existed. Idempotent: only versions with none yet are written,
// so an owner's choice is never overwritten. Prints the plan; --apply writes it.
//   node scripts/backfillFontFallbacks.js [--apply]
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import * as fileStore from "../src/services/certificates/storage/fileStore.js";
import { computeFontFallbacks } from "../src/services/certificates/analysis/fontFallbackMatch.js";

const apply = process.argv.includes("--apply");
const versions = await prisma.templateVersion.findMany({
  where: { sanitizedFileId: { not: null } },
  select: { id: true, sanitizedFileId: true, fontFallbacks: true },
});
let matched = 0;
let failed = 0;
for (const v of versions) {
  if (v.fontFallbacks) continue;
  try {
    const fontFallbacks = computeFontFallbacks(await fileStore.readText(v.sanitizedFileId));
    const summary = Object.entries(fontFallbacks).map(([ff, m]) => `${ff} ${m.pdfName} → ${m.fallbackFamily} ${m.weight} ${m.style}`);
    console.log(`${v.id}: ${summary.join(" · ") || "no embedded font"}`);
    if (apply) await prisma.templateVersion.update({ where: { id: v.id }, data: { fontFallbacks } });
    matched++;
  } catch (err) {
    failed++;
    console.error(`${v.id}: ${err.message}`);
  }
}
console.log(`${apply ? "Matched" : "Would match"} ${matched} of ${versions.length} versions, ${failed} failed${apply ? "" : ". Pass --apply to write."}`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
