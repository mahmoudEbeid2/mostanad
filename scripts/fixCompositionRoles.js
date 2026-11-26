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
let toRemap = 0;
for (const v of targets) {
  const name = `${v.template.name} v${v.versionNumber} (${v.status})`;
  // what would change in place (never written yet: a version blanked word by word is mapped again instead —
  // fixing single words of it in place would print a whole value over one word)
  const r = await applyCompositionRoles(v.id, { dryRun: true });
  if (!r.needsRemap.length) {
    if (apply) await applyCompositionRoles(v.id, { dryRun: false });
    for (const c of r.changed) log(`  ${name}: ${c.key} → ${c.to.role} ${JSON.stringify(c.to.source)} (was ${c.from.role || (c.from.isLabResult ? "lab result" : "—")} ${JSON.stringify(c.from.source)})`);
    inPlace += r.changed.length;
    continue;
  }
  log(`  ${name}: ${r.needsRemap.length} field(s) blanked word by word (${r.needsRemap.slice(0, 6).join(", ")}…) → a new version, mapped again`);
  toRemap++;
  if (!apply || v.status !== "active") continue;
  try {
    // resumable: a later version of this template this script already made (its fields carry the
    // composition roles) is picked up where it stopped — never a second clone
    const later = await prisma.templateVersion.findFirst({
      where: { templateId: v.template.id, versionNumber: { gt: v.versionNumber }, status: { in: ["draft", "preparing", "ready"] }, fields: { some: { role: { not: null } } } },
      orderBy: { versionNumber: "desc" },
      select: { id: true, versionNumber: true, status: true },
    });
    let copy;
    let made = null;
    if (later) {
      copy = { versionId: later.id, versionNumber: later.versionNumber };
      log(`  ${name}: resuming v${later.versionNumber} (${later.status})`);
      if (later.status === "preparing") await prisma.templateVersion.update({ where: { id: later.id }, data: { status: "draft" } }); // interrupted mid-prepare
    } else {
      copy = await cloneVersion(v.id, v.template.companyId, null);
      // the word-by-word blanks go; the person's own fields stay (the clone copied them)
      await prisma.templateField.deleteMany({ where: { versionId: copy.versionId, origin: "detected" } });
      made = await blankOpenAreas(copy.versionId, v.template.companyId);
      // the design's own number and date (suggested, left to type): the company's numbering and today
      for (const f of await prisma.templateField.findMany({ where: { versionId: copy.versionId, source: { path: ["kind"], equals: "manual" } } })) {
        const kind = /document\s*(no|number|#)|certificate\s*(no|number)|^document_number$/i.test(`${f.label} ${f.key}`) ? "docnumber" : /issue\s*date|^issue_date$/i.test(`${f.label} ${f.key}`) ? "today" : null;
        if (kind) await prisma.templateField.update({ where: { id: f.id }, data: { source: { kind }, ...(kind === "today" ? { format: { date: "DD/MM/YYYY" } } : {}) } });
      }
      log(`  ${name}: v${copy.versionNumber} made (${made} fields mapped)`);
    }
    const now = await prisma.templateVersion.findUnique({ where: { id: copy.versionId }, select: { status: true } });
    if (now.status === "draft") {
      await prisma.templateVersion.update({ where: { id: copy.versionId }, data: { status: "preparing", error: null } });
      const prep = await runPrepareJob(copy.versionId);
      if (prep.status !== "ready") {
        log(`  ${name}: v${copy.versionNumber} didn't pass the preparation check (${(prep.failing || []).join(", ")}) — left as a draft, the active version unchanged`);
        continue;
      }
    }
    await activateVersion(copy.versionId, v.template.companyId, null, { express: true });
    log(`  ${name}: v${copy.versionNumber} active, v${v.versionNumber} superseded`);
    remapped++;
  } catch (err) {
    log(`  ${name}: couldn't make the new version — ${err.message}`);
  }
}
log(`done: ${targets.length} composition version(s) — ${inPlace} field(s) ${apply ? "re-classified" : "to re-classify"} in place, ${toRemap} version(s) to map again${apply ? ` (${remapped} done)` : " (dry run — nothing written; add --apply)"}`);
await prisma.$disconnect();
process.exit(0); // the queue connection Express imports would keep the process alive
