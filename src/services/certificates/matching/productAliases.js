import { prisma } from "../../../lib/prisma.js";
import { normalizeName } from "./productMatcher.js";

// Learned invoice name → product (plan.md §7 "Confirmation and learning").
// Every confirmed match writes one: a person's (user_confirmed) or an AI match
// auto-accepted at/above the company threshold (ai_confirmed). The matcher
// reads them first, so the next invoice with the same line name matches
// without any AI call. Always tenant-scoped.

/** → Map(aliasNorm → productId) for one company */
export async function aliasMap(companyId) {
  const rows = await prisma.productAlias.findMany({ where: { companyId }, select: { aliasNorm: true, productId: true } });
  return new Map(rows.map((r) => [r.aliasNorm, r.productId]));
}

/** Remembers `name` → product for the company (a later confirmation to another product replaces it). */
export async function rememberAlias(companyId, name, productId, origin) {
  const aliasNorm = normalizeName(name);
  if (!aliasNorm || !productId) return null;
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) return null; // never across tenants
  return prisma.productAlias.upsert({
    where: { companyId_aliasNorm: { companyId, aliasNorm } },
    create: { companyId, aliasNorm, productId, origin },
    update: { productId, origin, timesUsed: { increment: 1 } },
  });
}
