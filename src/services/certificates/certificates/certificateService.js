import { prisma } from "../../../lib/prisma.js";
import { notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { listFields } from "../templates/fieldService.js";
import { loadBatch } from "../generation/batchService.js";

// Generated certificates — reads (CERTIFICATES_V2_PLAN.md §11, §12). Every
// read is tenant-scoped: another company's certificate is "not found".

export async function loadCertificate(id, companyId) {
  const c = await prisma.certificate.findUnique({ where: { id } });
  if (!c || (companyId && c.companyId !== companyId)) throw notFound("Certificate");
  return c;
}

const CARD_INCLUDE = {
  certificateType: { select: { id: true, code: true, name: true } },
  product: { select: { id: true, name: true, productCode: true } },
  invoice: { select: { id: true, header: true, country: true } },
  templateVersion: { select: { id: true, versionNumber: true, template: { select: { id: true, name: true, country: true, brand: { select: { name: true } } } } } },
  items: { orderBy: { position: "asc" }, select: { invoiceItem: { select: { id: true, lineNo: true, data: true } } } },
  versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { versionNumber: true, values: true, thumbnailFileId: true, htmlFileId: true, pdfFileId: true } },
};

/** The shape the cards / lists use (B4). */
export function toCard(c) {
  const current = c.versions?.[0] || null;
  const lines = (c.items || []).map((i) => i.invoiceItem);
  const flags = current ? Object.fromEntries(Object.entries(current.values || {}).filter(([, v]) => v.flags?.length).map(([k, v]) => [k, v.flags])) : {};
  return {
    id: c.id,
    status: c.status,
    error: c.error,
    scope: c.scope,
    flagCount: c.flagCount,
    flags,
    currentVersion: c.currentVersion,
    certificateType: c.certificateType,
    product: c.product,
    batchId: c.batchId,
    invoiceId: c.invoiceId,
    invoiceNumber: c.invoice?.header?.invoiceNumber || null,
    batchNo: c.scope === "per_product" ? lines[0]?.data?.batchNo || null : null,
    lineNos: lines.map((l) => l.lineNo),
    template: c.templateVersion ? { id: c.templateVersion.template.id, name: c.templateVersion.template.name, versionNumber: c.templateVersion.versionNumber, country: c.templateVersion.template.country, brand: c.templateVersion.template.brand?.name || null } : null,
    hasThumbnail: !!current?.thumbnailFileId,
    hasPdf: !!(c.finalPdfFileId || current?.pdfFileId),
    finalizedAt: c.finalizedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** GET /certificates — filters: invoiceId, batchId, status, certificateTypeId, flagged, q (§12). */
export async function listCertificates(companyId, { invoiceId, batchId, status, certificateTypeId, flagged, q, page = 1, limit = 20 } = {}) {
  const where = {
    companyId,
    ...(invoiceId ? { invoiceId } : {}),
    ...(batchId ? { batchId } : {}),
    ...(status ? { status } : {}),
    ...(certificateTypeId ? { certificateTypeId } : {}),
    ...(flagged === true || flagged === "true" ? { flagCount: { gt: 0 } } : {}),
    ...(q && String(q).trim() ? { search: { contains: String(q).trim().toLowerCase() } } : {}),
  };
  const take = Math.min(Number(limit) || 20, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const [total, rows] = await prisma.$transaction([
    prisma.certificate.count({ where }),
    prisma.certificate.findMany({ where, orderBy: [{ createdAt: "desc" }, { planKey: "asc" }], skip, take, include: CARD_INCLUDE }),
  ]);
  return { total, certificates: rows.map(toCard) };
}

/** GET /certificates/:id — current values + flags + the template's field definitions. */
export async function getCertificate(id, companyId) {
  await loadCertificate(id, companyId);
  const c = await prisma.certificate.findUnique({ where: { id }, include: CARD_INCLUDE });
  const fields = await listFields(c.templateVersionId);
  const current = c.versions[0] || null;
  return {
    ...toCard(c),
    values: current?.values || {},
    fields: fields.map((f) => ({ key: f.key, label: f.label, required: f.required, source: f.source, format: f.format, align: f.align, page: f.page, sortOrder: f.sortOrder })),
    lines: c.items.map((i) => i.invoiceItem),
    finalizedByUserId: c.finalizedByUserId,
    finalPdfFileId: c.finalPdfFileId,
  };
}

async function versionRow(certificateId, versionNumber) {
  const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId, versionNumber } } });
  if (!v) throw notFound("Certificate version");
  return v;
}

/** GET /certificates/:id/html?version=n — the stored static HTML (D9). */
export async function getCertificateHtml(id, companyId, version = null) {
  const c = await loadCertificate(id, companyId);
  const v = await versionRow(id, version ? Number(version) : c.currentVersion);
  if (!v.htmlFileId) throw notFound("Certificate HTML");
  return fileStore.readText(v.htmlFileId, { companyId: c.companyId });
}

/** GET /certificates/:id/thumbnail — page-1 PNG of the current version. */
export async function getCertificateThumbnail(id, companyId) {
  const c = await loadCertificate(id, companyId);
  const v = await versionRow(id, c.currentVersion);
  if (!v.thumbnailFileId) throw notFound("Thumbnail");
  return fileStore.readFile(v.thumbnailFileId, { companyId: c.companyId });
}

/** GET /certificate-batches/:id — progress + certificates (§12). */
export async function getBatch(id, companyId) {
  const b = await loadBatch(id, companyId);
  const certs = await prisma.certificate.findMany({ where: { batchId: id }, orderBy: [{ createdAt: "asc" }, { planKey: "asc" }], include: CARD_INCLUDE });
  const live = {
    planned: certs.length,
    pending: certs.filter((c) => c.status === "pending").length,
    rendered: certs.filter((c) => c.status === "draft" || c.status === "final").length,
    failed: certs.filter((c) => c.status === "failed").length,
    flagged: certs.filter((c) => c.status !== "failed" && c.flagCount > 0).length,
    final: certs.filter((c) => c.status === "final").length,
  };
  return { ...b, live, certificates: certs.map(toCard) };
}
