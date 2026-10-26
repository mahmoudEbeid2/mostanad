import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import { loadInvoice } from "../invoices/invoiceService.js";
import { listFields } from "../templates/fieldService.js";
import { isLabResult } from "../inference/policy.js";
import { CHECKABLE, recheckCode, storedValue } from "../dataNeeds/dataNeedsService.js";
import { batchOf, normBatch, normLabel, rememberBatchResult, forgetBatchResult } from "./batchResults.js";
import { inSpec } from "./specCheck.js";

// The results grid (fill automatically, item 4, owner 2026-10-26): ONE grid per invoice.
//   rows    = batches (every line of the same product + batch number is one row), or a line
//             without a batch number (its results stay on that line and are never reused);
//   columns = the lab-result fields its certificates need (by label), each cell with the
//             field's specification next to it and an out-of-spec flag (specCheck).
// One save writes every line of the row, stores the batch's results, and rechecks the
// invoice by code, so every certificate of those batches is filled. Fields printing their
// specification instead of a result are not in the grid: they never ask for a result.

const SPEC_LABEL = /\b(spec\w*|limits?|standards?|requirements?|range|norm)\b/i;

/** The field whose value is a lab result's specification: its link, else the plain spec cell on its row. */
function specFieldOf(field, fields) {
  if (field.specFieldKey) return fields.find((f) => f.key === field.specFieldKey) || null;
  const row = fields.filter((f) => f.key !== field.key && f.lineId === field.lineId && !f.groupKey && !f.showSpecInstead && !isLabResult(f));
  const named = row.filter((f) => SPEC_LABEL.test(f.label));
  if (named.length === 1) return named[0];
  const fromProduct = row.filter((f) => f.source?.kind === "product");
  return fromProduct.length === 1 ? fromProduct[0] : null;
}

/** Where a cell's value came from, in words the grid shows. */
function sourceOf(need, invoice) {
  if (need.value === null) return null;
  const p = need.provenance || {};
  if (p.kind === "batch_result") {
    const coa = p.source === "supplier_coa" ? `Supplier COA p.${p.page ?? "?"}` : null;
    if (p.fromInvoiceId && p.fromInvoiceId !== invoice.id) {
      const from = `From batch ${p.batchNo} (invoice ${p.fromInvoiceNumber || p.fromInvoiceId.slice(0, 8)})`;
      return { kind: "batch", text: coa ? `${from} · ${coa}` : from };
    }
    return coa ? { kind: "supplier_coa", text: coa, fileName: p.fileName || null } : { kind: "batch", text: `From batch ${p.batchNo} (this invoice)` };
  }
  if (p.kind === "supplier_coa") return { kind: "supplier_coa", text: `Supplier COA p.${p.page ?? "?"}${need.status === "needs_confirmation" ? " — read from a scan, confirm it" : ""}`, fileName: p.fileName || null };
  if (p.kind === "manual") return { kind: "manual", text: p.from?.kind === "supplier_coa" ? `Supplier COA p.${p.from.page ?? "?"} (confirmed)` : "Typed" };
  if (p.kind === "invoice_text") return { kind: "invoice", text: `Invoice p.${p.page ?? "?"}` };
  if (p.kind === "path") return { kind: "code", text: p.path };
  return { kind: p.kind || "code", text: p.kind || "code" };
}

const RANK = { provided: 6, reused: 5, resolved_ai: 4, resolved: 4, needs_confirmation: 3, missing: 1, not_applicable: 0 };

async function loadGridContext(invoice) {
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id, invoiceItemId: { not: null } } });
  const versionIds = [...new Set(needs.map((n) => n.templateVersionId))];
  const fieldsBy = new Map();
  for (const id of versionIds) fieldsBy.set(id, (await listFields(id)).filter((f) => !f.groupKey));
  const fieldOf = (n) => (fieldsBy.get(n.templateVersionId) || []).find((f) => f.key === n.fieldKey) || null;
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { lineNo: "asc" }, include: { product: { select: { id: true, name: true, companyId: true } } } });
  // tenant guard: a product of another company is no product here
  for (const it of items) if (it.product && it.product.companyId !== invoice.companyId) (it.product = null), (it.productId = null);
  const results = needs.filter((n) => {
    const f = fieldOf(n);
    return f && isLabResult(f) && !f.showSpecInstead;
  });
  return { needs, results, fieldsBy, fieldOf, items };
}

/** The row a line belongs to: its product + batch (reusable), or the line alone. */
const rowKeyOf = (item) => (item.productId && batchOf(item) ? `b:${item.productId}:${normBatch(batchOf(item))}` : `l:${item.id}`);

function buildGrid(invoice, gctx, coas) {
  const { needs, results, fieldsBy, fieldOf, items } = gctx;
  const itemById = new Map(items.map((i) => [i.id, i]));
  // columns: one per result label, in template order
  const columns = new Map();
  for (const n of results) {
    const f = fieldOf(n);
    const k = normLabel(n.label);
    const order = f.sortOrder ?? 0;
    if (!columns.has(k)) columns.set(k, { labelKey: k, label: n.label, order, required: false });
    const c = columns.get(k);
    c.order = Math.min(c.order, order);
    c.required ||= n.required;
  }
  const rows = new Map();
  for (const n of results) {
    const item = itemById.get(n.invoiceItemId);
    if (!item || item.matchStatus === "ignored") continue;
    const key = rowKeyOf(item);
    if (!rows.has(key)) {
      const batch = key.startsWith("b:") ? batchOf(item) : null;
      rows.set(key, {
        rowKey: key,
        reusable: !!batch,
        batchNo: batch || item.data?.batchNo || null,
        noBatch: !batchOf(item),
        productId: item.productId || null,
        productName: item.product?.name || item.data?.name || null,
        lines: [],
        cells: new Map(),
        ...(!batchOf(item) ? { warning: { code: "NO_BATCH_NUMBER", message: "No batch number — results can't be reused" } } : {}),
      });
    }
    const row = rows.get(key);
    if (!row.lines.some((l) => l.invoiceItemId === item.id)) row.lines.push({ invoiceItemId: item.id, lineNo: item.lineNo });
    const k = normLabel(n.label);
    if (!row.cells.has(k)) row.cells.set(k, { labelKey: k, needIds: [], statuses: [], best: null, spec: null, required: false });
    const cell = row.cells.get(k);
    cell.needIds.push(n.id);
    cell.statuses.push(n.status);
    cell.required ||= n.required;
    if (n.value !== null && (!cell.best || (RANK[n.status] ?? 2) > (RANK[cell.best.status] ?? 2))) cell.best = n;
    if (cell.spec === null) {
      const specField = specFieldOf(fieldOf(n), fieldsBy.get(n.templateVersionId) || []);
      const specNeed = specField ? needs.find((x) => x.planKey === n.planKey && x.fieldKey === specField.key) : null;
      if (specNeed?.value) cell.spec = specNeed.value;
    }
  }
  const view = [...rows.values()]
    .sort((a, b) => Math.min(...a.lines.map((l) => l.lineNo)) - Math.min(...b.lines.map((l) => l.lineNo)))
    .map((r) => ({
      ...r,
      lines: r.lines.sort((a, b) => a.lineNo - b.lineNo),
      cells: Object.fromEntries(
        [...r.cells.values()].map((c) => {
          const value = c.best?.value ?? null;
          const status = c.statuses.some((s) => s === "missing") ? "missing" : c.statuses.some((s) => s === "needs_confirmation") ? "needs_confirmation" : c.best?.status || c.statuses[0];
          const judged = value !== null ? inSpec(value, c.spec) : null;
          return [c.labelKey, { labelKey: c.labelKey, needIds: c.needIds, required: c.required, value, status, spec: c.spec, inSpec: judged, outOfSpec: judged === false, source: c.best ? sourceOf(c.best, invoice) : null, provenance: c.best?.provenance || null }];
        })
      ),
    }));
  const blocking = view.reduce((a, r) => a + Object.values(r.cells).filter((c) => c.required && ["missing", "needs_confirmation"].includes(c.status)).length, 0);
  return {
    invoiceId: invoice.id,
    columns: [...columns.values()].sort((a, b) => a.order - b.order).map(({ order, ...c }) => c),
    rows: view,
    summary: { rows: view.length, batches: view.filter((r) => r.reusable).length, linesWithoutBatch: view.filter((r) => r.noBatch).length, cells: view.reduce((a, r) => a + Object.keys(r.cells).length, 0), filled: view.reduce((a, r) => a + Object.values(r.cells).filter((c) => c.value !== null).length, 0), outOfSpec: view.reduce((a, r) => a + Object.values(r.cells).filter((c) => c.outOfSpec).length, 0), blocking },
    supplierCoas: coas.map(coaView),
  };
}

export const coaView = (c) => ({
  id: c.id,
  fileName: c.fileName,
  mimeType: c.mimeType,
  status: c.status,
  pages: c.pages,
  textSource: c.textSource,
  accepted: c.result?.accepted || [],
  rejected: c.result?.rejected || [],
  error: c.error,
  taskId: c.taskId,
  createdAt: c.createdAt,
});

/** GET /invoices/:id/lab-results → the grid (no AI, no writes). */
export async function getGrid(invoiceId, companyScope) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  const coas = await prisma.supplierCoa.findMany({ where: { invoiceId: invoice.id, companyId: invoice.companyId }, orderBy: { createdAt: "asc" } });
  return buildGrid(invoice, await loadGridContext(invoice), coas);
}

/**
 * PUT /invoices/:id/lab-results
 * rows: [{ rowKey, batchNo?, values: { [labelKey]: string | null } }]
 *   batchNo  — only for a row of a line without one: the batch number, asked first; empty
 *              = the results stay on that line only and are never reused;
 *   a value  — a person's result: every line of the row, and the batch's stored result;
 *   null/""  — cleared: the row's lines lose it, and so does the batch's stored result.
 * Then a code-only recheck (no AI), so every line / certificate of those batches is filled. → the grid
 */
export async function saveGrid(invoiceId, companyScope, input, userId = null) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `This invoice is ${invoice.status}`, 409);
  let gctx = await loadGridContext(invoice);
  if (!gctx.needs.length) {
    await recheckCode(invoice.id, invoice.companyId);
    gctx = await loadGridContext(invoice);
  }
  const now = new Date();
  const person = userId || "person";
  // 1. batch numbers first: a line that gets one joins its batch's row
  for (const r of input) {
    const batchNo = typeof r.batchNo === "string" ? r.batchNo.trim() : "";
    if (!batchNo) continue;
    if (!r.rowKey.startsWith("l:")) throw new CertError("BATCH_ALREADY_SET", "This row already has a batch number", 409);
    const item = gctx.items.find((i) => i.id === r.rowKey.slice(2));
    if (!item) throw new CertError("ROW_NOT_FOUND", `No line for row "${r.rowKey}"`, 404);
    if (batchOf(item)) throw new CertError("BATCH_ALREADY_SET", `Line ${item.lineNo} already has batch number ${batchOf(item)}`, 409);
    if (!normBatch(batchNo)) throw new CertError("INVALID_BATCH", "A batch number needs letters or digits", 422);
    const data = { ...(item.data || {}), batchNo: batchNo.slice(0, 100), batchNoSource: { kind: "manual", via: "results_grid", userId: person, at: now.toISOString() } };
    await prisma.invoiceItem.update({ where: { id: item.id }, data: { data } });
    item.data = data;
    r.rowKey = rowKeyOf(item);
  }
  // 2. the values
  for (const r of input) {
    const rowItems = gctx.items.filter((i) => rowKeyOf(i) === r.rowKey && i.matchStatus !== "ignored");
    if (!rowItems.length) throw new CertError("ROW_NOT_FOUND", `No line for row "${r.rowKey}"`, 404);
    for (const [labelKey, raw] of Object.entries(r.values || {})) {
      const cellNeeds = gctx.results.filter((n) => rowItems.some((i) => i.id === n.invoiceItemId) && normLabel(n.label) === labelKey);
      if (!cellNeeds.length) throw new CertError("UNKNOWN_RESULT", `This row has no lab result "${labelKey}"`, 422);
      const text = raw === null || raw === undefined ? "" : String(raw).trim();
      if (!text) {
        for (const item of rowItems) await forgetBatchResult(invoice.companyId, item, cellNeeds[0].label);
        for (const n of cellNeeds) await prisma.certificateDataNeed.update({ where: { id: n.id }, data: { status: n.required ? "missing" : "not_applicable", value: null, provenance: null, decidedByUserId: userId, decidedAt: now } });
        continue;
      }
      // unchanged (e.g. the whole grid saved again): keep where each value came from
      if (cellNeeds.every((n) => n.value === storedValue(gctx.fieldOf(n), text) && ["provided", "reused"].includes(n.status))) continue;
      // the batch's result, once per product + batch (a line without one keeps it on its own needs)
      const stored = new Map();
      for (const item of rowItems) {
        const k = rowKeyOf(item);
        if (stored.has(k) || !k.startsWith("b:")) continue;
        const prov = { kind: "manual", via: "results_grid", invoiceId: invoice.id, invoiceNumber: invoice.header?.invoiceNumber || null };
        stored.set(k, await rememberBatchResult({ companyId: invoice.companyId, item, field: gctx.fieldOf(cellNeeds[0]), value: text, source: "manual", provenance: prov, userId: person, invoiceId: invoice.id }));
      }
      for (const n of cellNeeds) {
        const value = storedValue(gctx.fieldOf(n), text);
        if (n.value === value && ["provided", "reused"].includes(n.status)) continue; // unchanged: keep where it came from
        const item = rowItems.find((i) => i.id === n.invoiceItemId);
        const br = stored.get(rowKeyOf(item));
        const provenance = { kind: "manual", via: "results_grid", ...(br ? { batchNo: br.batchNo, batchResultId: br.id } : { lineOnly: true }) };
        await prisma.certificateDataNeed.update({ where: { id: n.id }, data: { status: "provided", value, provenance, decidedByUserId: userId, decidedAt: now } });
      }
    }
  }
  // 3. every line of these batches (and everything code can now fill), no AI
  await recheckCode(invoice.id, invoice.companyId);
  return getGrid(invoice.id, invoice.companyId);
}
