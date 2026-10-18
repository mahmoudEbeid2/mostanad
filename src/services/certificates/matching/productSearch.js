import { prisma } from "../../../lib/prisma.js";

// Tenant-forced product search for the certificate screens (test fill §13.4,
// manual matching §9.3). Always `where: { companyId }` — the V1 GET /products
// route filters by query string only, so it is not used here (plan §20 I14).
export async function searchProducts(companyId, { q = "", limit = 20 } = {}) {
  const term = String(q || "").trim();
  return prisma.product.findMany({
    where: {
      companyId,
      ...(term
        ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { productCode: { contains: term, mode: "insensitive" } }] }
        : {}),
    },
    select: { id: true, name: true, productCode: true, packaging: true, brand: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
    take: Math.min(Number(limit) || 20, 50),
  });
}
