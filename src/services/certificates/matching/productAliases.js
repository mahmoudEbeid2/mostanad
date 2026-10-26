import { prisma } from "../../../lib/prisma.js";
import { normalizeName } from "./productMatcher.js";

// Learned invoice name → product (plan.md §7 "Confirmation and learning"). Owner, 2026-10-27:
// an alias is learned ONLY when a person explicitly asks for it ("remember this name for next
// invoices") — never by picking a product for a line, and never by the AI (an auto-accepted
// match stays a match on that line only). Each row records who confirmed it, when, and on which
// invoice line. The matcher reads confirmed rows only, so rows written before this rule (no
// confirmedAt) don't match anything. Always tenant-scoped.

/** → Map(aliasNorm → productId) for one company: confirmed aliases only */
export async function aliasMap(companyId) {
  const rows = await prisma.productAlias.findMany({ where: { companyId, confirmedAt: { not: null } }, select: { aliasNorm: true, productId: true } });
  return new Map(rows.map((r) => [r.aliasNorm, r.productId]));
}

/**
 * A person confirmed: `name` is `productId` for this company from now on (a later confirmation to
 * another product replaces it). userId null = a company session. → the row, or null
 */
export async function confirmAlias({ companyId, name, productId, userId = null, invoiceId = null, invoiceItemId = null }) {
  const aliasNorm = normalizeName(name);
  if (!aliasNorm || !productId) return null;
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) return null; // never across tenants
  const confirmed = { origin: "user_confirmed", confirmedAt: new Date(), confirmedByUserId: userId, sourceInvoiceId: invoiceId, sourceInvoiceItemId: invoiceItemId };
  return prisma.productAlias.upsert({
    where: { companyId_aliasNorm: { companyId, aliasNorm } },
    create: { companyId, aliasNorm, productId, ...confirmed },
    update: { productId, ...confirmed, timesUsed: { increment: 1 } },
  });
}
