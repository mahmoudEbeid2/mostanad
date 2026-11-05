// One-off, after the font fallback backfill: draft certificates keep the glyph: flag they
// were stored with until they are rendered again. This renders those drafts with their
// stored values; a draft whose flags change gets a new version (nothing is overwritten),
// so running it again finds nothing to do. Final certificates are never touched.
// Prints the plan; --apply writes it. Needs the renderer.
//   node scripts/rerenderGlyphDrafts.js [--apply]
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { rerenderGlyphDraft } from "../src/services/certificates/certificates/editService.js";

const apply = process.argv.includes("--apply");
const rows = await prisma.$queryRaw`
  SELECT DISTINCT c.id
  FROM certificates c
  JOIN certificate_versions v ON v.certificate_id = c.id AND v.version_number = c.current_version
  CROSS JOIN LATERAL jsonb_each(v.values) AS e(key, value)
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value->'flags') = 'array' THEN e.value->'flags' ELSE '[]'::jsonb END) AS f(flag)
  WHERE c.status = 'draft' AND f.flag LIKE 'glyph:%'`;

const tally = { changed: 0, unchanged: 0, failed: 0 };
for (const { id } of rows) {
  try {
    const r = await rerenderGlyphDraft(id, { apply });
    tally[r.changed ? "changed" : "unchanged"]++;
    console.log(`${id}: ${r.changed ? `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}` : "no change"}${r.version ? ` (version ${r.version})` : ""}`);
  } catch (err) {
    tally.failed++;
    console.error(`${id}: ${err.code || ""} ${err.message}`);
  }
}
console.log(`${rows.length} drafts with a glyph flag: ${tally.changed} ${apply ? "updated" : "would change"}, ${tally.unchanged} unchanged, ${tally.failed} failed${apply ? "" : ". Pass --apply to write."}`);
await prisma.$disconnect();
process.exit(tally.failed ? 1 : 0);
