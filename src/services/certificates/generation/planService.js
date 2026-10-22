import { prisma } from "../../../lib/prisma.js";
import { selectTemplates } from "./templateSelector.js";

// The generation plan of an invoice (CERTIFICATES_V2_PLAN.md §10.1): its
// lines + the company's active templates → templateSelector. Shared by
// generation (batchService) and the certificate data check (plan.md §6.1).

async function planInputs(invoice) {
  const [items, templates] = await Promise.all([
    prisma.invoiceItem.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { lineNo: "asc" },
      include: { product: { select: { id: true, name: true, brandId: true, brand: { select: { id: true, name: true } } } } },
    }),
    prisma.certificateTemplate.findMany({
      where: { companyId: invoice.companyId, archivedAt: null, activeVersionId: { not: null }, certificateType: { isActive: true } },
      include: { certificateType: { select: { code: true, name: true } }, brand: { select: { name: true } } },
    }),
  ]);
  const versions = await prisma.templateVersion.findMany({ where: { id: { in: templates.map((t) => t.activeVersionId) } }, select: { id: true, versionNumber: true } });
  const byId = new Map(versions.map((v) => [v.id, v]));
  return { items, templates: templates.map((t) => ({ ...t, activeVersion: byId.get(t.activeVersionId) || null })) };
}

export async function computePlan(invoice) {
  const { items, templates } = await planInputs(invoice);
  return selectTemplates({ invoice: { country: invoice.country, brandId: invoice.brandId }, items, templates });
}
