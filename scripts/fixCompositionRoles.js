// Phase 1 data fix (28 Nov): every Certificate of Composition template's ingredient table becomes the
// product's composition (roles composition_name / composition_amount / composition_basis), never
// "Analysis result" blanks. Idempotent and additive; nothing is deleted.
//
//   node scripts/fixCompositionRoles.js            → what would change (dry run)
//   node scripts/fixCompositionRoles.js --apply    → applies it
//   … --company <id>                              → one company only
//
// A version whose rows were marked whole (or name / amount) is fixed in place — its prepared file stays
// valid (only sources and roles change). A version whose rows were blanked word by word (the first Express
// runs) can't be: a NEW version is cloned from it, its open places mapped again (autoMap: composition rows
// by role), prepared and activated; the old one is superseded, never changed. Every change is logged.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { applyCompositionRoles, isCompositionTemplate } from "../src/services/certificates/templates/compositionRoles.js";
import { cloneVersion, runPrepareJob, activateVersion } from "../src/services/certificates/templates/prepareService.js";
import { blankOpenAreas } from "../src/services/intake/expressService.js";

const apply = process.argv.includes("--apply");
const onlyCompany = process.argv.includes("--company") ? process.argv[process.argv.indexOf("--company") + 1] : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const versions = await prisma.templateVersion.findMany({
  where: { status: { in: ["active", "ready", "draft"] }, template: { archivedAt: null, ...(onlyCompany ? { companyId: onlyCompany } : {}) } },
  select: { id: true, status: true, versionNumber: true, template: { select: { id: true, name: true, companyId: true, certificateType: { select: { code: true, name: true } } } } },
});
const targets = versions.filter((v) => isCompositionTemplate(v.template));
log(`${apply ? "APPLY" : "DRY RUN"} — ${targets.length} composition template version(s)`);

let inPlace = 0;
let remapped = 0;
for (const v of targets) {
  const name = `${v.template.name} v${v.versionNumber} (${v.status})`;
  const r = await applyCompositionRoles(v.id, { dryRun: !apply });
  for (const c of r.changed) log(`  ${name}: ${c.key} → ${c.to.role} ${JSON.stringify(c.to.source)} (was ${c.from.role || (c.from.isLabResult ? "lab result" : "—")} ${JSON.stringify(c.from.source)})`);
  inPlace += r.changed.length;
  if (!r.needsRemap.length) continue;
  log(`  ${name}: ${r.needsRemap.length} field(s) blanked word by word (${r.needsRemap.slice(0, 6).join(", ")}…) → a new version, mapped again`);
  if (!apply || v.status !== "active") continue;
  try {
    const copy = await cloneVersion(v.id, v.template.companyId, null);
    // the word-by-word blanks go; the person's own fields stay (the clone copied them)
    await prisma.templateField.deleteMany({ where: { versionId: copy.versionId, origin: "detected" } });
    const made = await blankOpenAreas(copy.versionId, v.template.companyId);
    await prisma.templateVersion.update({ where: { id: copy.versionId }, data: { status: "preparing", error: null } });
    const prep = await runPrepareJob(copy.versionId);
    if (prep.status !== "ready") {
      log(`  ${name}: the new version v${copy.versionNumber} didn't pass the preparation check (${(prep.failing || []).join(", ")}) — left as a draft, the active version unchanged`);
      continue;
    }
    await activateVersion(copy.versionId, v.template.companyId, null, { express: true });
    log(`  ${name}: v${copy.versionNumber} active (${made} fields mapped), v${v.versionNumber} superseded`);
    remapped++;
  } catch (err) {
    log(`  ${name}: couldn't make the new version — ${err.message}`);
  }
}
log(`done: ${inPlace} field(s) re-classified in place, ${remapped} version(s) mapped again${apply ? "" : " (dry run — nothing written; add --apply)"}`);
await prisma.$disconnect();
