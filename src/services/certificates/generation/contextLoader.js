import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";

// Loads the data a field's source resolves from (CERTIFICATES_V2_PLAN.md §10.3)
// — always tenant-scoped: a product of another company is "not found".

const COMPANY_SELECT = { id: true, name: true, address: true, phone: true, email: true };

export async function loadProduct(companyId, productId) {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId },
    include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } },
  });
  if (!product) throw notFound("Product");
  return product;
}

/**
 * → resolver context { product?, brand?, company, item?, invoice?, today }.
 * `invoiceItemId` is supported once invoices exist (Phase 3).
 */
export async function loadProductContext(companyId, { productId = null, invoiceItemId = null } = {}) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT });
  const ctx = { company, today: new Date() };
  if (invoiceItemId) {
    if (!prisma.invoiceItem) throw new CertError("INVOICES_UNAVAILABLE", "Invoice lines are not available yet", 400);
    const item = await prisma.invoiceItem.findFirst({ where: { id: invoiceItemId, invoice: { companyId } }, include: { invoice: true } });
    if (!item) throw notFound("Invoice item");
    ctx.item = item.data || {};
    ctx.invoice = item.invoice.header || {};
    if (!productId && item.productId) productId = item.productId;
    // an invoice_lines group (§7.8) previews with every line of that invoice, as a collective certificate would
    const lines = await prisma.invoiceItem.findMany({
      where: { invoiceId: item.invoiceId, matchStatus: { not: "ignored" } },
      orderBy: { lineNo: "asc" },
      include: { product: { include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } } },
    });
    ctx.lines = lines.map((l) => ({ ...(l.data || {}), product: l.product && l.product.companyId === companyId ? l.product : {} }));
  }
  if (productId) {
    ctx.product = await loadProduct(companyId, productId);
    ctx.brand = ctx.product.brand || null;
  }
  return ctx;
}
