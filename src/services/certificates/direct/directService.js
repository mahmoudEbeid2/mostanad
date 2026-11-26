import { prisma } from "../../../lib/prisma.js";
import * as fileStore from "../storage/fileStore.js";
import { CertError } from "../errors.js";
import { usableTemplates } from "../generation/planService.js";
import { selectTemplates } from "../generation/templateSelector.js";
import { startGeneration } from "../generation/batchService.js";
import { readinessMap } from "../templates/readinessService.js";

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

/**
 * Certificates for SEVERAL products at once, no invoice (client: "certificates for these
 * products", one click): ONE direct request holding every product (one line each, with the
 * batch facts the person gave for it — never filled in) and every chosen type, generated in
 * one run. Per-product templates make one certificate per product; a per-invoice template
 * (an FSC or HC listing several products) makes ONE certificate covering them all.
 * products: [{ productId, batch? }]. dryRun → only the plan (nothing saved).
 * → { invoiceId?, batchId?, taskId?, planned: [{ type, products, scope }], missing: [{ product, type }] }
 */
export async function generateForProducts({ companyId, userId = null, products = [], certificateTypeIds = [], country = null, dryRun = false, express = null }) {
  if (!products.length) throw new CertError("PRODUCTS_REQUIRED", "Choose at least one product", 400);
  if (products.length > 100) throw new CertError("TOO_MANY_PRODUCTS", "At most 100 products at once", 400);
  if (!certificateTypeIds.length) throw new CertError("TYPES_REQUIRED", "Choose at least one certificate type", 400);
  const ids = [...new Set(products.map((p) => p.productId))];
  const [rows, types, templates] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, name: true, productCode: true, brandId: true, brand: { select: { id: true, name: true } } } }),
    prisma.certificateType.findMany({ where: { id: { in: certificateTypeIds }, companyId, isActive: true }, select: { id: true, code: true, name: true } }),
    usableTemplates({ companyId }),
  ]);
  if (rows.length !== ids.length) throw new CertError("NOT_FOUND", "Product not found!", 404);
  if (types.length !== new Set(certificateTypeIds).size) throw new CertError("NOT_FOUND", "Certificate type not found (or not active) in this company", 404);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const lines = ids.map((id, i) => ({ id: `direct-${i + 1}`, lineNo: i + 1, productId: id, matchStatus: "matched", product: byId.get(id) }));
  // one brand when they all share it (a brand's templates apply); otherwise the company's own
  const brands = [...new Set(rows.map((p) => p.brandId || null))];
  const brandId = brands.length === 1 ? brands[0] : null;
  const plan = selectTemplates({ invoice: { country: clean(country), brandId, certificateTypeIds: types.map((t) => t.id) }, items: lines, templates });
  const lineName = new Map(lines.map((l) => [l.id, l.product.name]));
  const planned = plan.entries.map((e) => ({ type: types.find((t) => t.id === e.certificateTypeId)?.code || null, scope: e.scope || null, products: (e.invoiceItemIds || []).map((i) => lineName.get(i)).filter(Boolean) }));
  const missing = [];
  for (const t of types) for (const l of lines) if (!plan.entries.some((e) => e.certificateTypeId === t.id && (e.invoiceItemIds || []).includes(l.id))) missing.push({ product: l.product.name, type: t.code });
  if (dryRun) {
    // a template that would be refused (unmarked batch / date / result text): said before "Make", with its link
    const ready = await readinessMap(plan.entries.map((e) => e.templateVersionId));
    const notReady = Object.entries(ready).filter(([, r]) => !r.ready).map(([versionId, r]) => ({ versionId, type: types.find((t) => t.id === plan.entries.find((e) => e.templateVersionId === versionId)?.certificateTypeId)?.code || null, message: r.message, link: r.link, open: r.open }));
    return { planned, missing, notReady };
  }
  if (!plan.entries.length) throw new CertError("NOTHING_TO_GENERATE", `No active template applies to these products for ${types.map((t) => t.code).join(", ")} — make or activate one first`, 409, { missing });

  const batchOf = new Map(products.map((p) => [p.productId, Object.fromEntries(BATCH_FACTS.map((k) => [k, clean(p.batch?.[k])]))]));
  const request = { kind: "direct_certificates", products: ids.map((id) => ({ productId: id, batch: batchOf.get(id) })), certificateTypeIds: types.map((t) => t.id), country: clean(country), by: userId, at: new Date().toISOString(), ...(express ? { express } : {}) };
  const source = await fileStore.putFile({ companyId, kind: "direct_request", buffer: Buffer.from(JSON.stringify(request, null, 2)), mimeType: "application/json", originalName: `${types.map((t) => t.code).join("+")} ${ids.length} products.json`, ext: "json" });
  const today = new Date().toISOString().slice(0, 10);
  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      origin: "direct",
      status: "ready",
      sourceFileId: source.id,
      brandId,
      country: clean(country)?.toUpperCase().slice(0, 2) || null,
      certificateTypeIds: types.map((t) => t.id),
      header: { invoiceNumber: null, invoiceDate: { iso: today, raw: today }, direct: true, ...(express ? { express } : {}) },
      headerExtracted: {},
      reviewedAt: new Date(),
      reviewedByUserId: userId,
      uploadedByUserId: userId,
      items: { create: ids.map((id, i) => ({ lineNo: i + 1, productId: id, matchStatus: "matched", matchMethod: "user", dataExtracted: {}, data: { name: byId.get(id).name, code: byId.get(id).productCode || null, ...batchOf.get(id), extra: {} } })) },
    },
  });
  const out = await startGeneration(invoice.id, companyId, userId);
  return { invoiceId: invoice.id, ...out, planned, missing };
}
