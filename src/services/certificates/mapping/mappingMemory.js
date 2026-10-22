import { prisma } from "../../../lib/prisma.js";
import { normLabel } from "./labelProposal.js";
import { validateSource, validateFormat } from "../templates/sourceCatalogue.js";

// FieldMappingMemory (plan.md §4, §5.1 step 7, §5.2 step 1): what a company
// confirmed a label means. Step 1 of the mapping chain — a hit never calls
// the AI. Written when a version is activated (all its fields) and when a
// person confirms an AI mapping.

/** → the memory row for this label (this certificate type first, then any type), or null. */
export async function recallMapping(companyId, label, certificateTypeId = null) {
  const labelNorm = normLabel(label);
  if (!labelNorm) return null;
  const rows = await prisma.fieldMappingMemory.findMany({
    where: { companyId, labelNorm },
    orderBy: [{ timesUsed: "desc" }, { lastUsedAt: "desc" }],
  });
  const row = rows.find((r) => r.certificateTypeId === certificateTypeId) || rows[0] || null;
  // a remembered source must still be valid (the catalogue may have changed)
  if (row && (validateSource(row.source).length || validateFormat(row.format, row.source).length)) return null;
  return row;
}

/**
 * Remembers label → source/format/category for every plain field (group
 * cells read their row, not a source). A label used by two fields of the
 * same version is ambiguous and is not remembered.
 */
export async function rememberMappings(companyId, certificateTypeId, fields, userId = null) {
  const plain = fields.filter((f) => !f.groupKey && normLabel(f.label));
  const counts = new Map();
  for (const f of plain) counts.set(normLabel(f.label), (counts.get(normLabel(f.label)) || 0) + 1);
  const now = new Date();
  let written = 0;
  for (const f of plain) {
    const labelNorm = normLabel(f.label);
    if (counts.get(labelNorm) > 1) continue;
    const data = { source: f.source, format: f.format ?? undefined, category: f.dataCategory ?? null, lastUsedAt: now };
    await prisma.fieldMappingMemory.upsert({
      where: { companyId_labelNorm_certificateTypeId: { companyId, labelNorm, certificateTypeId } },
      create: { companyId, labelNorm, certificateTypeId, createdByUserId: userId, ...data },
      update: { ...data, format: f.format ?? null, timesUsed: { increment: 1 } },
    });
    written++;
  }
  return written;
}
