import { prisma } from "../../../lib/prisma.js";
import { loadInvoice } from "../invoices/invoiceService.js";
import { listFields } from "../templates/fieldService.js";
import { fromSource, resolve, parse } from "../paths/sourcePath.js";
import { TEMPLATE_TOKEN_RE } from "../templates/sourceCatalogue.js";
import { isLabResult } from "../inference/policy.js";
import { maskEstimates } from "../../catalogues/fieldProvenance.js";

// Why is a certificate value missing? (owner, 2026-10-24, item 1). Read-only:
// every `missing` need of the invoice's data check, with its template field,
// source path and the reason, sorted into what fixes it:
//   template_mapping — the template doesn't say where the value comes from
//                      (no source, an unnamed field, a path no product has);
//   product_data     — the template is right, this product lacks the value;
//   lab_result       — a per-batch analysis result: only a supplier COA, an
//                      earlier result of the same batch, or a person;
//   invoice_data     — the invoice (line) doesn't carry it.
// Reasons are computed by code from the stored rows; nothing is changed.

export const DIAGNOSIS_GROUPS = ["template_mapping", "product_data", "lab_result", "invoice_data"];
const GENERIC_LABEL = /^field\s*\d+$/i;
const MAX_PRODUCTS = 2000;

const pathOf = (source) => {
  const s = source || { kind: "manual" };
  if (s.kind === "manual") return "manual (typed by hand)";
  if (s.kind === "static") return `fixed text “${s.text ?? ""}”`;
  if (s.kind === "today") return "today";
  if (s.kind === "template") return `combination ${s.template}`;
  return fromSource(s) || `${s.kind}.${s.path || ""}`;
};

/** The placeholders of a combination source → [{ kind, path }] */
const refsOf = (source) =>
  source?.kind === "template" ? [...String(source.template || "").matchAll(TEMPLATE_TOKEN_RE)].map((m) => ({ kind: m[1], path: m[2] })).filter((r) => r.kind !== "today") : [];

/**
 * One missing need → { group, reason }.
 * ctx: { item (invoice line, data), product (masked, or null), companyHas(fullPath) → number of the company's products holding it }
 */
export function classifyMissing(field, ctx) {
  if (!field) return { group: "template_mapping", reason: "the template field no longer exists in this version — run the data check again" };
  const label = String(field.label || "");
  if (isLabResult(field)) {
    const batch = String(ctx.item?.batchNo || "").trim();
    return {
      group: "lab_result",
      reason: batch
        ? `a per-batch analysis result: no supplier COA and no earlier result for batch ${batch} yet`
        : "a per-batch analysis result, and the invoice line has no batch number (results are stored per product + batch)",
    };
  }
  const s = field.source || { kind: "manual" };
  if (s.kind === "manual") {
    if (GENERIC_LABEL.test(label)) return { group: "template_mapping", reason: `an unnamed field (“${label}”, printed “${field.sampleValue}”) with no source — nobody said what it is` };
    if (!field.dataCategory || field.dataCategory === "unknown") return { group: "template_mapping", reason: `no source and no category: “${label}” is typed by hand on every certificate` };
    return { group: "template_mapping", reason: `no source: “${label}” is typed by hand on every certificate` };
  }
  const refs = s.kind === "template" ? refsOf(s) : [{ kind: s.kind, path: s.path }];
  for (const r of refs) {
    const full = `${r.kind}.${r.path}`;
    if (r.kind === "item") {
      if (!String(resolve({ item: ctx.item || {} }, full).value ?? "").trim()) return { group: "invoice_data", reason: `the invoice line has no ${r.path}` };
    } else if (r.kind === "invoice") {
      if (!resolve({ invoice: ctx.invoice || {} }, full).found) return { group: "invoice_data", reason: `the invoice header has no ${r.path}` };
    } else if (r.kind === "product" || r.kind === "brand") {
      if (!ctx.product) return { group: "product_data", reason: "the invoice line is not matched to a product" };
      if (r.kind === "product" && !resolve({ product: ctx.product }, full).found) {
        const has = ctx.companyHas(full);
        if (!has) return { group: "template_mapping", reason: `no product of this company has ${full} — the field probably points at the wrong key` };
        return { group: "product_data", reason: `${ctx.product.name} has no value at ${full} (${has} other product(s) do)` };
      }
    } else if (r.kind === "company") {
      return { group: "invoice_data", reason: `the company profile has no ${r.path}` };
    }
  }
  return { group: s.kind === "product" ? "product_data" : "template_mapping", reason: "the source is empty for this certificate" };
}

/**
 * GET /invoices/:id/data-needs/diagnosis → {
 *   summary: { certificates, values, missing, byGroup },
 *   groups: { [group]: [{ templateName, versionId, versionStatus, fieldKey, label, sourcePath, reason, count, certificates: [{ planKey, lineNo, productName }] }] },
 *   entries: [{ needId, planKey, lineNo, productName, templateName, fieldKey, label, sourcePath, group, reason }]
 * }
 */
export async function diagnoseInvoice(invoiceId, companyScope) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  const rows = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id }, orderBy: [{ planKey: "asc" }, { fieldKey: "asc" }] });
  const versionIds = [...new Set(rows.map((r) => r.templateVersionId))];
  const versions = new Map((await prisma.templateVersion.findMany({ where: { id: { in: versionIds } }, include: { template: { select: { name: true, companyId: true, activeVersionId: true } } } })).map((v) => [v.id, v]));
  const fields = new Map();
  for (const id of versionIds) fields.set(id, await listFields(id));
  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId: invoice.id },
    include: { product: { include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } } },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  // "does ANY product of the company hold this path?" separates a wrong mapping from a product gap
  const products = await prisma.product.findMany({ where: { companyId: invoice.companyId }, take: MAX_PRODUCTS });
  const hasCache = new Map();
  const companyHas = (full) => {
    if (!parse(full).ok) return 0;
    if (!hasCache.has(full)) hasCache.set(full, products.filter((p) => resolve({ product: maskEstimates(p) }, full).found).length);
    return hasCache.get(full);
  };

  const entries = [];
  for (const r of rows.filter((x) => x.status === "missing")) {
    const v = versions.get(r.templateVersionId);
    const field = (fields.get(r.templateVersionId) || []).find((f) => f.key === r.fieldKey) || null;
    const item = r.invoiceItemId ? itemById.get(r.invoiceItemId) : null;
    // tenant guard, as everywhere: a product is read for its own company only
    const product = item?.product && item.product.companyId === invoice.companyId ? maskEstimates(item.product) : null;
    const { group, reason } = classifyMissing(field, { item: item?.data || {}, invoice: invoice.header || {}, product, companyHas });
    entries.push({
      needId: r.id,
      planKey: r.planKey,
      lineNo: item?.lineNo ?? null,
      productName: product?.name || item?.data?.name || null,
      templateName: v?.template?.name || null,
      versionId: r.templateVersionId,
      versionStatus: v?.status || null,
      fieldKey: r.fieldKey,
      label: r.label,
      sourcePath: field ? pathOf(field.source) : null,
      group,
      reason,
    });
  }
  const groups = Object.fromEntries(DIAGNOSIS_GROUPS.map((g) => [g, []]));
  const agg = new Map();
  for (const e of entries) {
    const k = `${e.group}|${e.versionId}|${e.fieldKey}|${e.reason}`;
    if (!agg.has(k)) {
      const row = { templateName: e.templateName, versionId: e.versionId, versionStatus: e.versionStatus, fieldKey: e.fieldKey, label: e.label, sourcePath: e.sourcePath, reason: e.reason, count: 0, certificates: [] };
      agg.set(k, row);
      groups[e.group].push(row);
    }
    const row = agg.get(k);
    row.count++;
    row.certificates.push({ planKey: e.planKey, lineNo: e.lineNo, productName: e.productName });
  }
  const certificates = new Set(rows.map((r) => r.planKey)).size;
  // needs computed against a version that is no longer the template's active one are stale
  const stale = [...versions.values()].filter((v) => v.template.activeVersionId !== v.id).map((v) => ({ versionId: v.id, templateName: v.template.name, status: v.status }));
  return {
    invoiceId: invoice.id,
    summary: { certificates, values: rows.length, missing: entries.length, byGroup: Object.fromEntries(DIAGNOSIS_GROUPS.map((g) => [g, entries.filter((e) => e.group === g).length])) },
    groups,
    entries,
    ...(stale.length ? { staleVersions: stale } : {}),
  };
}
