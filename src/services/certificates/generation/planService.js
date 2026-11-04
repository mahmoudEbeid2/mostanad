import { prisma } from "../../../lib/prisma.js";
import { selectTemplates } from "./templateSelector.js";

// The generation plan of an invoice (CERTIFICATES_V2_PLAN.md §10.1): its
// lines + the company's active templates → templateSelector. Shared by
// generation (batchService) and the certificate data check (plan.md §6.1).

/** The company's active templates, as the selector reads them. */
export async function usableTemplates(invoice) {
  const templates = await prisma.certificateTemplate.findMany({
    where: { companyId: invoice.companyId, archivedAt: null, activeVersionId: { not: null }, certificateType: { isActive: true } },
    include: { certificateType: { select: { code: true, name: true } }, brand: { select: { name: true } } },
  });
  const versions = await prisma.templateVersion.findMany({ where: { id: { in: templates.map((t) => t.activeVersionId) } }, select: { id: true, versionNumber: true } });
  const byId = new Map(versions.map((v) => [v.id, v]));
  return templates.map((t) => ({ ...t, activeVersion: byId.get(t.activeVersionId) || null }));
}

async function planInputs(invoice) {
  const [items, templates] = await Promise.all([
    prisma.invoiceItem.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { lineNo: "asc" },
      include: { product: { select: { id: true, name: true, brandId: true, brand: { select: { id: true, name: true } } } } },
    }),
    usableTemplates(invoice),
  ]);
  return { items, templates };
}

export const selectorInvoice = (invoice) => ({ country: invoice.country, brandId: invoice.brandId, certificateTypeIds: invoice.certificateTypeIds ?? null });

export async function computePlan(invoice) {
  const { items, templates } = await planInputs(invoice);
  return selectTemplates({ invoice: selectorInvoice(invoice), items, templates });
}

/**
 * What each usable type would make for this invoice, chosen or not, for the review chips.
 * → [{ certificateTypeId, typeCode, typeName, selected, count, scopes }]
 */
function typeCounts(everyType, templates, chosenIds) {
  const out = new Map();
  for (const t of templates) {
    if (!out.has(t.certificateTypeId)) out.set(t.certificateTypeId, { certificateTypeId: t.certificateTypeId, typeCode: t.certificateType?.code || null, typeName: t.certificateType?.name || null, selected: !chosenIds || chosenIds.includes(t.certificateTypeId), count: 0, scopes: [] });
    const row = out.get(t.certificateTypeId);
    if (!row.scopes.includes(t.scope)) row.scopes.push(t.scope);
  }
  for (const e of everyType.entries) out.get(e.certificateTypeId).count++;
  return [...out.values()].sort((a, b) => String(a.typeCode).localeCompare(String(b.typeCode)));
}

/** The plan plus `types`, what every usable type would make (GET /invoices/:id/generation-plan). */
export async function previewPlan(invoice) {
  const { items, templates } = await planInputs(invoice);
  const plan = selectTemplates({ invoice: selectorInvoice(invoice), items, templates });
  const everyType = selectTemplates({ invoice: { ...selectorInvoice(invoice), certificateTypeIds: null }, items, templates });
  return { ...plan, types: typeCounts(everyType, templates, plan.certificateTypeIds) };
}
