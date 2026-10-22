import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { extractInvoice } from "./invoiceExtractor.js";
import { dateValue } from "./dateNormalizer.js";
import { normalizeQuantity } from "./quantityNormalizer.js";
import { INVOICE_HEADER_FIELDS, INVOICE_ITEM_FIELDS } from "./invoiceSchema.js";
import { matchInvoice } from "../matching/productMatcher.js";

// Invoices (CERTIFICATES_V2_PLAN.md §9): upload → extract (AI) → review →
// confirm → ready. Extraction output is frozen in headerExtracted /
// dataExtracted; the user edits `header` / `data` only.

export const MAX_INVOICE_BYTES = 15 * 1024 * 1024;
const MIME = {
  pdf: { mime: "application/pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  png: { mime: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
const EDITABLE = ["review", "ready"];

/** Magic bytes decide the type — the declared mime type and file name don't. */
export function detectInvoiceFormat(buffer) {
  if (!buffer?.length) throw new CertError("EMPTY_FILE", "The uploaded file is empty", 400);
  if (buffer.length > MAX_INVOICE_BYTES) throw new CertError("FILE_TOO_LARGE", "Invoices are limited to 15 MB", 413);
  const hit = Object.entries(MIME).find(([, m]) => m.magic(buffer));
  if (!hit) throw new CertError("UNSUPPORTED_FORMAT", "Upload the invoice as a PDF, PNG, JPEG or WebP file", 400);
  return { ext: hit[0], mimeType: hit[1].mime };
}

export async function loadInvoice(id, companyId) {
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv || (companyId && inv.companyId !== companyId)) throw notFound("Invoice");
  return inv;
}

async function assertBrand(companyId, brandId) {
  if (!brandId) return;
  const b = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!b || b.companyId !== companyId) throw notFound("Brand");
}

const normCountry = (c) => (c ? String(c).trim().toUpperCase() : null);

/** POST /invoices → { invoiceId, taskId } */
export async function uploadInvoice({ companyId, userId, file, brandId = null, country = null }) {
  const { ext, mimeType } = detectInvoiceFormat(file?.buffer);
  await assertBrand(companyId, brandId);
  const invoice = await prisma.$transaction(async (tx) => {
    const src = await fileStore.putFile({ companyId, kind: "invoice_source", buffer: file.buffer, mimeType, originalName: file.originalname || null, ext, tx });
    return tx.invoice.create({
      data: { companyId, brandId: brandId || null, country: normCountry(country), status: "uploaded", sourceFileId: src.id, uploadedByUserId: userId || null },
    });
  });
  const task = await enqueueTask({
    queueName: QUEUES.invoice,
    jobName: "extract",
    type: "invoice_extract",
    companyId,
    data: { entity: "invoice", entityId: invoice.id, invoiceId: invoice.id },
  });
  return { invoiceId: invoice.id, taskId: task.id };
}

/**
 * The `extract` job (§9.1): file → Gemini → frozen raw output + editable
 * copies → automatic matching → `review`. A failure leaves the invoice
 * `failed` with the provider's real message and ZERO items.
 */
export async function runExtractJob(invoiceId, ctx = {}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw notFound("Invoice");
  if (["review", "ready", "generating", "generated", "partially_failed"].includes(invoice.status)) return { invoiceId, status: invoice.status, skipped: true }; // idempotent retry
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "extracting", error: null } });
  try {
    ctx.progress?.(10, "Reading the invoice");
    const { row, buffer } = await fileStore.readFile(invoice.sourceFileId);
    const out = await extractInvoice(buffer, row.mimeType, { companyId: invoice.companyId, invoiceId });
    ctx.progress?.(70, `Found ${out.items.length} lines`);
    const country = invoice.country || normCountry(out.header.customerCountry && /^[A-Za-z]{2}$/.test(out.header.customerCountry) ? out.header.customerCountry : null);
    await prisma.$transaction([
      prisma.invoiceItem.deleteMany({ where: { invoiceId } }),
      prisma.invoiceItem.createMany({ data: out.items.map((it) => ({ invoiceId, lineNo: it.lineNo, data: it.data, dataExtracted: it.data })) }),
      prisma.invoice.update({
        where: { id: invoiceId },
        data: { header: out.header, headerExtracted: { ...out.header, _raw: out.raw.header || null }, extraction: out.provenance, country, textContent: out.textContent },
      }),
    ]);
    ctx.progress?.(85, "Matching products");
    const match = await matchInvoice(invoiceId);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "review" } });
    return { invoiceId, status: "review", items: out.items.length, ...match };
  } catch (err) {
    await prisma.$transaction([
      prisma.invoiceItem.deleteMany({ where: { invoiceId } }),
      prisma.invoice.update({ where: { id: invoiceId }, data: { status: "failed", error: err.code ? `${err.code}: ${err.message}` : err.message } }),
    ]);
    throw err;
  }
}

/**
 * POST /invoices/:id/retry — re-runs extraction of a FAILED invoice with the
 * same model and prompt (e.g. after a quota error). Not a fallback: nothing
 * changes but the attempt. → { invoiceId, taskId }
 */
export async function retryExtraction(invoiceId, companyId) {
  const inv = await loadInvoice(invoiceId, companyId);
  const claimed = await prisma.invoice.updateMany({ where: { id: invoiceId, status: "failed" }, data: { status: "uploaded", error: null } });
  if (!claimed.count) throw new CertError("INVOICE_NOT_FAILED", `Only a failed invoice can be read again (this one is ${inv.status})`, 409);
  const task = await enqueueTask({
    queueName: QUEUES.invoice,
    jobName: "extract",
    type: "invoice_extract",
    companyId: inv.companyId,
    data: { entity: "invoice", entityId: invoiceId, invoiceId },
  });
  return { invoiceId, taskId: task.id };
}

// ── reads ────────────────────────────────────────────────────────────────────
/** Ids of a company's invoices whose number or customer contains `q` (case-insensitive). */
async function searchInvoiceIds(companyId, q) {
  const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRaw`
    SELECT id FROM invoices
    WHERE company_id = ${companyId}
      AND (header->>'invoiceNumber' ILIKE ${like} OR header->>'customerName' ILIKE ${like})`;
  return rows.map((r) => r.id);
}

// The stored invoice text (plan.md §6.1, up to 200 KB) leaves the API only
// through GET /invoices/:id (tenant-scoped like every by-id read). Every
// other invoice response — the list, PATCH, confirm — omits it.
const TEXT_OMIT = { textContent: true };

export async function listInvoices(companyId, { status, q, page = 1, limit = 20 } = {}) {
  const where = { companyId, ...(status ? { status } : {}) };
  if (q && String(q).trim()) where.id = { in: await searchInvoiceIds(companyId, String(q).trim()) };
  const take = Math.min(Number(limit) || 20, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const [total, rows] = await prisma.$transaction([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      omit: TEXT_OMIT,
      include: { brand: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    }),
  ]);
  // "Certificates" column (mockup B1): generated certificates per invoice, and how many are final
  const groups = rows.length
    ? await prisma.certificate.groupBy({ by: ["invoiceId", "status"], where: { invoiceId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
    : [];
  const countsFor = (id) => {
    const g = groups.filter((x) => x.invoiceId === id);
    return { total: g.reduce((n, x) => n + x._count._all, 0), final: g.filter((x) => x.status === "final").reduce((n, x) => n + x._count._all, 0) };
  };
  return { total, invoices: rows.map((r) => ({ ...r, certificateCounts: countsFor(r.id) })) };
}

export async function getInvoice(id, companyId) {
  await loadInvoice(id, companyId);
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: {
      brand: { select: { id: true, name: true } },
      items: { orderBy: { lineNo: "asc" }, include: { product: { select: { id: true, name: true, productCode: true, brandId: true } } } },
      batches: { orderBy: { createdAt: "desc" }, select: { id: true, status: true, counts: true, createdAt: true, finishedAt: true } },
    },
  });
  const source = await prisma.storedFile.findUnique({ where: { id: inv.sourceFileId }, select: { mimeType: true, originalName: true, sizeBytes: true } });
  const counts = inv.items.reduce((acc, it) => ({ ...acc, [it.matchStatus]: (acc[it.matchStatus] || 0) + 1 }), {});
  return { ...inv, source, counts };
}

export async function getSource(id, companyId) {
  const inv = await loadInvoice(id, companyId);
  return fileStore.readFile(inv.sourceFileId, { companyId: inv.companyId });
}

// ── review edits (§9.3) ──────────────────────────────────────────────────────
function assertEditable(inv) {
  if (!EDITABLE.includes(inv.status)) throw new CertError("INVOICE_NOT_EDITABLE", `This invoice is ${inv.status}; only an invoice under review can be edited`, 409);
}

/** Editing a confirmed invoice sends it back to review (it must be confirmed again). */
const reopen = (inv) => (inv.status === "ready" ? { status: "review", reviewedAt: null, reviewedByUserId: null } : {});

function mergeFields(current, patch, defs) {
  const next = { ...(current || {}) };
  for (const f of defs) {
    if (!(f.path in patch)) continue;
    const v = patch[f.path];
    if (f.type === "date") next[f.path] = dateValue(v);
    else if (f.type === "number") {
      // the same reading as extraction: "1.250,5" is accepted, "1.250" is refused, never silently 1.25 (review #4)
      const q = v === null || v === "" ? { value: null } : normalizeQuantity(v);
      if (q.ambiguous) throw new CertError("AMBIGUOUS_QUANTITY", `${f.label} "${v}" could be thousands or a decimal — write it without the separator (e.g. 1250) or with a decimal part (e.g. 1.25 or 1.250,00)`, 422);
      const n = q.value;
      if (n === null && v !== null && v !== "") throw new CertError("INVALID_VALUE", `${f.label} must be a number`, 422);
      next[f.path] = n;
      if (f.path === "quantity") {
        next.quantityRaw = v === null || v === "" ? null : String(v);
        delete next.quantityAmbiguous; // the reviewer typed the number (review #4)
      }
    } else next[f.path] = v === null ? null : String(v).trim() || null;
  }
  return next;
}

/** PATCH /invoices/:id — { header?, brandId?, country? } */
export async function updateInvoice(id, companyId, { header, brandId, country }) {
  const inv = await loadInvoice(id, companyId);
  assertEditable(inv);
  if (brandId) await assertBrand(inv.companyId, brandId);
  return prisma.invoice.update({
    where: { id },
    omit: TEXT_OMIT,
    data: {
      ...(header ? { header: mergeFields(inv.header, header, INVOICE_HEADER_FIELDS) } : {}),
      ...(brandId !== undefined ? { brandId: brandId || null } : {}),
      ...(country !== undefined ? { country: normCountry(country) } : {}),
      ...reopen(inv),
    },
  });
}

async function loadItem(invoiceId, itemId, companyId) {
  const inv = await loadInvoice(invoiceId, companyId);
  const item = await prisma.invoiceItem.findUnique({ where: { id: itemId } });
  if (!item || item.invoiceId !== inv.id) throw notFound("Invoice item");
  return { inv, item };
}

async function assertProduct(companyId, productId) {
  const p = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!p) throw notFound("Product");
}

/** POST /invoices/:id/items — a line the extraction missed. */
export async function addItem(invoiceId, companyId, { data = {}, productId = null }) {
  const inv = await loadInvoice(invoiceId, companyId);
  assertEditable(inv);
  if (productId) await assertProduct(inv.companyId, productId);
  const last = await prisma.invoiceItem.findFirst({ where: { invoiceId }, orderBy: { lineNo: "desc" } });
  const [item] = await prisma.$transaction([
    prisma.invoiceItem.create({
      data: {
        invoiceId,
        lineNo: (last?.lineNo || 0) + 1,
        data: { extra: {}, ...mergeFields({}, data, INVOICE_ITEM_FIELDS) },
        dataExtracted: {}, // added by hand — nothing was extracted
        productId,
        matchStatus: productId ? "matched" : "needs_match",
        matchMethod: productId ? "user" : null,
      },
    }),
    prisma.invoice.update({ where: { id: invoiceId }, data: reopen(inv) }),
  ]);
  return item;
}

/** PATCH /invoices/:id/items/:itemId — { data?, productId?, ignored? } */
export async function updateItem(invoiceId, itemId, companyId, { data, productId, ignored }) {
  const { inv, item } = await loadItem(invoiceId, itemId, companyId);
  assertEditable(inv);
  const patch = {};
  if (data) patch.data = mergeFields(item.data, data, INVOICE_ITEM_FIELDS);
  if (productId !== undefined) {
    if (productId) {
      await assertProduct(inv.companyId, productId);
      Object.assign(patch, { productId, matchStatus: "matched", matchMethod: "user" });
    } else Object.assign(patch, { productId: null, matchStatus: "needs_match", matchMethod: null });
  }
  if (ignored === true) Object.assign(patch, { matchStatus: "ignored" });
  if (ignored === false && item.matchStatus === "ignored") Object.assign(patch, { matchStatus: (patch.productId ?? item.productId) ? "matched" : "needs_match" });
  const [updated] = await prisma.$transaction([prisma.invoiceItem.update({ where: { id: itemId }, data: patch }), prisma.invoice.update({ where: { id: invoiceId }, data: reopen(inv) })]);
  return updated;
}

export async function deleteItem(invoiceId, itemId, companyId) {
  const { inv } = await loadItem(invoiceId, itemId, companyId);
  assertEditable(inv);
  await prisma.$transaction([prisma.invoiceItem.delete({ where: { id: itemId } }), prisma.invoice.update({ where: { id: invoiceId }, data: reopen(inv) })]);
}

/** POST /invoices/:id/rematch — lines matched/ignored by hand are kept. */
export async function rematch(invoiceId, companyId) {
  const inv = await loadInvoice(invoiceId, companyId);
  assertEditable(inv);
  const res = await matchInvoice(invoiceId);
  await prisma.invoice.update({ where: { id: invoiceId }, data: reopen(inv) });
  return res;
}

/** POST /invoices/:id/confirm → ready (§9.3). */
export async function confirmInvoice(invoiceId, companyId, userId) {
  const inv = await loadInvoice(invoiceId, companyId);
  if (inv.status !== "review") throw new CertError("INVOICE_NOT_IN_REVIEW", `Only an invoice under review can be confirmed (this one is ${inv.status})`, 409);
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId }, orderBy: { lineNo: "asc" }, select: { lineNo: true, matchStatus: true } });
  const open = items.filter((i) => i.matchStatus === "needs_match").map((i) => i.lineNo);
  if (open.length) throw new CertError("ITEMS_NEED_MATCH", `Match or ignore every line first (lines ${open.join(", ")})`, 409, { lines: open });
  if (!items.some((i) => i.matchStatus === "matched")) throw new CertError("NO_MATCHED_ITEMS", "At least one line must be matched to a product", 409);
  return prisma.invoice.update({ where: { id: invoiceId }, omit: TEXT_OMIT, data: { status: "ready", reviewedAt: new Date(), reviewedByUserId: userId || null } });
}
