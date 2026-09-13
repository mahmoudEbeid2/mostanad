// scripts/backfillNeverGuessFields.js — CLAUDE.md invariant #5 was amended to
// require strength/withdrawalPeriod/shelfLifeAfterOpening/registrationNumber/
// batchNo/expiryDate to never be null (labelSchema.js dropped .nullable() on
// all six). Any GeneratedLabel row written before that change can have a raw
// `null` in one of these paths — labelSchema.parse() now rejects that value,
// so every read path that re-validates label_data (approval, versioning,
// chat-patch) would throw on those rows.
//
// This is a one-time, idempotent content correction on DRAFT data only:
//   - generated_labels.label_data (the live/current draft)
//   - label_versions.label_data (each historical version's own draft content)
// It deliberately does NOT touch label_approvals.label_snapshot — invariant
// #12 makes that a frozen historical record of what was actually approved;
// rewriting it after the fact would falsify history, not fix a bug.
//
// LocalizedText fields (strength/withdrawalPeriod/shelfLifeAfterOpening) get
// the same "empty-but-present" shape already used by this session's own test
// fixtures ({ translations: {}, primary: "" }) — schema-valid, and caught as
// FAIL by validationEngine's applicability layer (isEmptyValue) wherever the
// field is actually required, rather than silently passing.
//
// String fields (registrationNumber/batchNo/expiryDate) can't use "" — the
// schema requires z.string().min(1). A blank string on a printed label is
// exactly what invariant #5 exists to prevent, so these get an explicit
// sentinel instead of a fabricated-looking value.
//
// Every path this script touches is added to labelData.estimatedFields, so
// approvalService's signedEstimatedFields gate forces a human to sign off on
// it — an old null was never reviewed as a real value, and this backfill must
// not make it look like one now.
//
// Usage: node scripts/backfillNeverGuessFields.js [--dry-run]
import { prisma } from "../src/lib/prisma.js";

const NEVER_GUESS_LOCALIZED = ["strength", "withdrawalPeriod", "shelfLifeAfterOpening"];
const NEVER_GUESS_STRING = ["registrationNumber", "batchNo", "expiryDate"];
const STRING_SENTINEL = "UNSPECIFIED — pre-existing record, backfilled";

const dryRun = process.argv.includes("--dry-run");

function needsBackfill(labelData) {
  if (!labelData || typeof labelData !== "object") return false;
  return [...NEVER_GUESS_LOCALIZED, ...NEVER_GUESS_STRING].some((f) => labelData[f] === null || labelData[f] === undefined);
}

// Mutates a copy — never the caller's object — and returns { labelData, touchedPaths }.
function backfill(labelData) {
  const next = { ...labelData };
  const touched = [];

  for (const field of NEVER_GUESS_LOCALIZED) {
    if (next[field] === null || next[field] === undefined) {
      next[field] = { translations: {}, primary: "" };
      touched.push(field);
    }
  }
  for (const field of NEVER_GUESS_STRING) {
    if (next[field] === null || next[field] === undefined) {
      next[field] = STRING_SENTINEL;
      touched.push(field);
    }
  }
  if (touched.length > 0) {
    next.estimatedFields = [...new Set([...(next.estimatedFields || []), ...touched])];
  }
  return { labelData: next, touched };
}

async function countAffected() {
  const [labelRows, versionRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT id FROM generated_labels
      WHERE label_data->>'strength' IS NULL OR label_data->'strength' = 'null'::jsonb
         OR label_data->>'withdrawalPeriod' IS NULL OR label_data->'withdrawalPeriod' = 'null'::jsonb
         OR label_data->>'shelfLifeAfterOpening' IS NULL OR label_data->'shelfLifeAfterOpening' = 'null'::jsonb
         OR label_data->>'registrationNumber' IS NULL
         OR label_data->>'batchNo' IS NULL
         OR label_data->>'expiryDate' IS NULL
    `,
    prisma.$queryRaw`
      SELECT id FROM label_versions
      WHERE label_data->>'strength' IS NULL OR label_data->'strength' = 'null'::jsonb
         OR label_data->>'withdrawalPeriod' IS NULL OR label_data->'withdrawalPeriod' = 'null'::jsonb
         OR label_data->>'shelfLifeAfterOpening' IS NULL OR label_data->'shelfLifeAfterOpening' = 'null'::jsonb
         OR label_data->>'registrationNumber' IS NULL
         OR label_data->>'batchNo' IS NULL
         OR label_data->>'expiryDate' IS NULL
    `,
  ]);
  return { labelRows, versionRows };
}

async function run() {
  const { labelRows, versionRows } = await countAffected();
  console.log(`generated_labels rows affected: ${labelRows.length}`);
  console.log(`label_versions rows affected: ${versionRows.length}`);

  if (dryRun) {
    console.log("--dry-run: no writes performed.");
    return;
  }
  if (labelRows.length === 0 && versionRows.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  for (const { id } of labelRows) {
    const row = await prisma.generatedLabel.findUnique({ where: { id }, select: { labelData: true } });
    if (!needsBackfill(row.labelData)) continue; // re-check: another run may have already fixed it
    const { labelData, touched } = backfill(row.labelData);
    await prisma.generatedLabel.update({ where: { id }, data: { labelData } });
    console.log(`generated_labels ${id}: backfilled [${touched.join(", ")}]`);
  }

  for (const { id } of versionRows) {
    const row = await prisma.labelVersion.findUnique({ where: { id }, select: { labelData: true } });
    if (!needsBackfill(row.labelData)) continue;
    const { labelData, touched } = backfill(row.labelData);
    await prisma.labelVersion.update({ where: { id }, data: { labelData } });
    console.log(`label_versions ${id}: backfilled [${touched.join(", ")}]`);
  }

  console.log("Backfill complete.");
}

run()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
