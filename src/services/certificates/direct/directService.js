import { prisma } from "../../../lib/prisma.js";
import * as fileStore from "../storage/fileStore.js";
import { CertError } from "../errors.js";
import { usableTemplates } from "../generation/planService.js";
import { selectTemplates } from "../generation/templateSelector.js";
import { startGeneration } from "../generation/batchService.js";

// Certificates for a product without an invoice (client report 24 Nov: "don't
// use a number"). The same engine — plan, values, versions, PDF — runs on an
// internal invoice record of origin "direct": one line, the product, and the
// batch facts the person typed (or a supplier COA read onto it later). It is
// not shown in invoice lists; the certificates are ordinary drafts.

export const BATCH_FACTS = ["batchNo", "productionDate", "expiryDate", "quantity", "unit", "packing"];

const clean = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

async function loadRefs(companyId, { productId, certificateTypeId }) {
  const [product, type] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true, name: true, productCode: true, brandId: true, brand: { select: { id: true, name: true } } } }),
    prisma.certificateType.findFirst({ where: { id: certificateTypeId, companyId, isActive: true }, select: { id: true, code: true, name: true } }),
  ]);
  if (!product) throw new CertError("NOT_FOUND", "Product not found!", 404);
  if (!type) throw new CertError("NOT_FOUND", "Certificate type not found (or not active) in this company", 404);
  return { product, type };
}

/**
 * What a direct request would make, without saving anything: the template the
 * engine would use for this product and type. → { product, type, entries, template | null }
 */
export async function planDirect(companyId, { productId, certificateTypeId, country = null }) {
  const { product, type } = await loadRefs(companyId, { productId, certificateTypeId });
  const templates = await usableTemplates({ companyId });
  const items = [{ id: "direct", lineNo: 1, productId: product.id, matchStatus: "matched", product }];
  const plan = selectTemplates({ invoice: { country: country || null, brandId: product.brandId || null, certificateTypeIds: [type.id] }, items, templates });
  const entry = plan.entries[0] || null;
  const template = entry ? templates.find((t) => t.activeVersionId === entry.templateVersionId) || null : null;
  return { product, type, entries: plan.entries, template: template ? { id: template.id, name: template.name, brand: template.brand?.name || null, country: template.country || null } : null };
}

/**
 * The internal invoice record for one product and its batch facts → { invoiceId }.
 * Batch facts are stored as given (the caller checks they came from the person).
 */
export async function createDirectRequest({ companyId, userId = null, productId, certificateTypeId, batch = {}, country = null }) {
  const { product, type } = await loadRefs(companyId, { productId, certificateTypeId });
  const facts = Object.fromEntries(BATCH_FACTS.map((k) => [k, clean(batch[k])]));
  const request = { kind: "direct_certificate", productId: product.id, certificateTypeId: type.id, country: clean(country), batch: facts, by: userId, at: new Date().toISOString() };
  const source = await fileStore.putFile({ companyId, kind: "direct_request", buffer: Buffer.from(JSON.stringify(request, null, 2)), mimeType: "application/json", originalName: `${type.code} ${product.name}.json`, ext: "json" });
  const today = new Date().toISOString().slice(0, 10);
  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      origin: "direct",
      status: "ready",
      sourceFileId: source.id,
      brandId: product.brandId || null,
      country: clean(country)?.toUpperCase().slice(0, 2) || null,
      certificateTypeIds: [type.id],
      header: { invoiceNumber: null, invoiceDate: { iso: today, raw: today }, direct: true },
      headerExtracted: {},
      reviewedAt: new Date(),
      reviewedByUserId: userId,
      uploadedByUserId: userId,
      items: {
        create: [{ lineNo: 1, productId: product.id, matchStatus: "matched", matchMethod: "user", dataExtracted: {}, data: { name: product.name, code: product.productCode || null, ...facts, extra: {} } }],
      },
    },
  });
  return { invoiceId: invoice.id };
}

/**
 * A certificate draft for one product, no invoice: the request record, then the
 * usual Generate. → { invoiceId, batchId, taskId, planned }
 */
export async function generateForProduct({ companyId, userId = null, productId, certificateTypeId, batch = {}, country = null }) {
  const plan = await planDirect(companyId, { productId, certificateTypeId, country });
  if (!plan.entries.length) throw new CertError("NOTHING_TO_GENERATE", `No active ${plan.type.code} template applies to ${plan.product.name}${plan.product.brand ? ` (${plan.product.brand.name})` : ""} — make one first`, 409);
  const { invoiceId } = await createDirectRequest({ companyId, userId, productId, certificateTypeId, batch, country });
  const out = await startGeneration(invoiceId, companyId, userId);
  return { invoiceId, ...out };
}
