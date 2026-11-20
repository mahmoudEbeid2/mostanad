import { z } from "zod";
import { defineTool } from "../registry.js";
import { page, ref } from "../trim.js";
import { pageArgs, id, pg } from "./common.js";
import { listInvoices, getInvoice } from "../../../certificates/invoices/invoiceService.js";
import { getNeeds } from "../../../certificates/dataNeeds/dataNeedsService.js";
import { getGrid } from "../../../certificates/labResults/resultsGrid.js";
import { listCertificates, getCertificate } from "../../../certificates/certificates/certificateService.js";
import { listVersions } from "../../../certificates/certificates/editService.js";
import { listTemplates, getTemplate, getVersionDetail } from "../../../certificates/templates/templateService.js";
import { listTypes } from "../../../certificates/types/certificateTypeService.js";
import { getMetrics } from "../../../certificates/maintenance/maintenanceService.js";
import { findInvoices } from "../../reads.js";

const INVOICE_STATUSES = ["uploaded", "extracting", "review", "ready", "generating", "generated", "partially_failed", "failed"];
const CERT_STATUSES = ["pending", "draft", "final", "failed"];
const invoiceNo = (inv) => inv.header?.invoiceNumber || null;
const invoiceRef = (inv) => ref("invoice", inv, invoiceNo(inv) || "invoice");

// ── invoices ────────────────────────────────────────────────────────────────
defineTool({
  name: "search_invoices",
  module: "invoices",
  risk: "read",
  permissions: ["read_invoices"],
  label: "Searching invoices",
  description:
    "Find invoices by invoice number or customer name (`q`, partial match) and/or status, newest first. Returns id, number, customer, status, line count and certificate counts. " +
    `Statuses: ${INVOICE_STATUSES.join(", ")}.`,
  args: z.object({ q: z.string().max(80).optional(), status: z.enum(INVOICE_STATUSES).optional(), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, invoices } = ctx.companyId || !a.q ? await listInvoices(ctx.companyId || undefined, { status: a.status, q: a.q, page: p, limit }) : await findInvoices(null, { q: a.q, status: a.status, page: p, limit });
    const items = invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: invoiceNo(inv),
      customer: inv.header?.customerName || null,
      date: inv.header?.invoiceDate || null,
      status: inv.status,
      lines: inv._count?.items ?? null,
      certificates: inv.certificateCounts || null,
      ...(ctx.companyId ? {} : { companyId: inv.companyId, company: inv.company?.name }),
      createdAt: inv.createdAt,
      ref: invoiceRef(inv),
    }));
    return page(items, total, { page: p, limit });
  },
});

defineTool({
  name: "get_invoice",
  module: "invoices",
  risk: "read",
  permissions: ["read_invoices"],
  label: "Reading the invoice",
  description:
    "One invoice: header (number, date, customer, country), status, and its lines — line number, product name/code as printed, batch, dates, quantity, which product it is matched to (or needs matching) — and the generation batches.",
  args: z.object({ invoiceId: id("invoice") }),
  run: async (a, ctx) => {
    const inv = await getInvoice(a.invoiceId, ctx.companyId || undefined);
    return {
      id: inv.id,
      status: inv.status,
      header: inv.header,
      country: inv.country,
      brand: inv.brand?.name || null,
      error: inv.error || null,
      counts: inv.counts,
      lines: inv.items.map((it) => ({
        lineNo: it.lineNo,
        name: it.data?.name ?? null,
        code: it.data?.code ?? null,
        batchNo: it.data?.batchNo ?? null,
        productionDate: it.data?.productionDate ?? null,
        expiryDate: it.data?.expiryDate ?? null,
        quantity: it.data?.quantity ?? null,
        unit: it.data?.unit ?? null,
        matchStatus: it.matchStatus,
        product: it.product ? { id: it.product.id, name: it.product.name, productCode: it.product.productCode, ref: ref("product", it.product) } : null,
      })),
      batches: inv.batches.map((b) => ({ id: b.id, status: b.status, counts: b.counts, createdAt: b.createdAt })),
      ref: invoiceRef(inv),
    };
  },
});

defineTool({
  name: "get_invoice_data_check",
  module: "invoices",
  risk: "read",
  permissions: ["read_invoices"],
  label: "Reading the data check",
  description:
    "What is still missing before an invoice's certificates can be generated: the stored data check (as last computed — this never re-runs it). " +
    "Summary counts (ready, missing required, missing optional, needs confirmation, blocking) and, per certificate, each value that is missing or awaiting a person, " +
    "marked labResult / batchFact. Lab results and batch facts can only come from the lab or the batch — never suggest a value for them.",
  args: z.object({ invoiceId: id("invoice"), includeSettled: z.boolean().optional().describe("Also list values that are already filled (default false)") }),
  run: async (a, ctx) => {
    const v = await getNeeds(a.invoiceId, ctx.companyId || undefined);
    const keep = (n) => a.includeSettled || !["resolved", "resolved_ai", "provided", "reused", "not_applicable"].includes(n.status);
    return {
      summary: v.summary,
      computedAt: v.computedAt,
      warnings: v.warnings,
      certificates: v.certificates.map((c) => ({
        type: c.typeName || c.typeCode,
        template: c.templateName,
        lineNos: c.lineNos,
        product: c.productName,
        batchNo: c.batchNo,
        open: c.needs.filter(keep).map((n) => ({ label: n.label, status: n.status, required: n.required, value: n.display ?? n.value ?? null, labResult: n.labResult, batchFact: n.batchFact, estimated: n.estimated })),
      })),
      ref: { type: "invoice", id: a.invoiceId, name: null },
    };
  },
});

defineTool({
  name: "get_invoice_lab_results",
  module: "invoices",
  risk: "read",
  permissions: ["read_invoices"],
  label: "Reading lab results",
  description: "The lab results grid of an invoice: per line/batch, each lab-result column and the stored value (or empty), with its source (manual, supplier COA, reused from the batch).",
  args: z.object({ invoiceId: id("invoice") }),
  run: async (a, ctx) => {
    const g = await getGrid(a.invoiceId, ctx.companyId || undefined);
    return { columns: (g.columns || []).map((c) => ({ key: c.key || c.labelKey, label: c.label, required: c.required })), rows: g.rows, coas: (g.coas || []).map((c) => ({ id: c.id, fileName: c.fileName, status: c.status })) };
  },
});

// ── certificates ────────────────────────────────────────────────────────────
defineTool({
  name: "list_certificates",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificates"],
  label: "Listing certificates",
  description:
    "Certificates, newest first, filtered by invoice, status, certificate type, flagged (has blocking flags) or free text `q` (product name, batch number or invoice number). " +
    `Statuses: ${CERT_STATUSES.join(", ")}. For counts per company/type/status/date use count_records.`,
  args: z.object({
    invoiceId: z.string().uuid().optional(),
    status: z.enum(CERT_STATUSES).optional(),
    certificateTypeId: z.string().uuid().optional(),
    flagged: z.boolean().optional(),
    q: z.string().max(80).optional(),
    ...pageArgs,
  }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, certificates } = await listCertificates(ctx.companyId || undefined, { ...a, page: p, limit });
    const items = certificates.map((c) => ({
      id: c.id,
      status: c.status,
      type: c.certificateType?.code,
      product: c.product?.name || null,
      batchNo: c.batchNo,
      invoiceNumber: c.invoiceNumber,
      invoiceId: c.invoiceId,
      flagCount: c.flagCount,
      template: c.template?.name || null,
      createdAt: c.createdAt,
      ref: ref("certificate", c, `${c.certificateType?.code || "Certificate"} ${c.product?.name || c.invoiceNumber || ""}`.trim()),
    }));
    return page(items, total, { page: p, limit });
  },
});

defineTool({
  name: "get_certificate",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificates"],
  label: "Reading the certificate",
  description:
    "One certificate: status, type, product, invoice, template, and every field's current value with where it came from (source), any flags, and whether the field is required. " +
    "Values are as stored — report empty ones as empty.",
  args: z.object({ certificateId: id("certificate") }),
  run: async (a, ctx) => {
    const c = await getCertificate(a.certificateId, ctx.companyId || undefined);
    const values = c.values || {};
    return {
      id: c.id,
      status: c.status,
      type: c.certificateType,
      product: c.product ? { ...c.product, ref: ref("product", c.product) } : null,
      invoice: { id: c.invoiceId, invoiceNumber: c.invoiceNumber, ref: ref("invoice", { id: c.invoiceId }, c.invoiceNumber) },
      template: c.template,
      currentVersion: c.currentVersion,
      flagCount: c.flagCount,
      finalizedAt: c.finalizedAt,
      fields: c.fields.map((f) => {
        const v = values[f.key] || {};
        return { key: f.key, label: f.label, required: f.required, value: v.value ?? null, origin: v.origin || null, source: v.source?.kind || f.source?.kind || null, edited: !!v.editedByUserId, flags: v.flags?.length ? v.flags : undefined };
      }),
      ref: ref("certificate", c, `${c.certificateType?.code || "Certificate"} ${c.product?.name || ""}`.trim()),
    };
  },
});

defineTool({
  name: "get_certificate_versions",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificates"],
  label: "Reading certificate versions",
  description: "The version history of one certificate: version number, when, by whom, and why (render, edit, restore).",
  args: z.object({ certificateId: id("certificate") }),
  run: async (a, ctx) => {
    const rows = await listVersions(a.certificateId, ctx.companyId || undefined);
    return { total: rows.length, items: rows.map((v) => ({ versionNumber: v.versionNumber, changeSource: v.changeSource, changeSummary: v.changeSummary, changedBy: v.changedBy, flagCount: v.flagCount, createdAt: v.createdAt })) };
  },
});

defineTool({
  name: "get_certificate_metrics",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificates"],
  needsCompany: true,
  label: "Reading certificate metrics",
  description: "Certificate pipeline health for one company over the last `days` (default 30): template conversions, prepare pass rate, generation batches, rendered/failed/flagged certificates, invoice extraction failures by reason.",
  args: z.object({ days: z.number().int().min(1).max(365).optional() }),
  run: (a, ctx) => getMetrics(ctx.companyId, { days: a.days || 30 }),
});

// ── templates and types ─────────────────────────────────────────────────────
defineTool({
  name: "list_certificate_types",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificate_types"],
  needsCompany: true,
  label: "Listing certificate types",
  description: "The company's certificate types (e.g. COA, Health certificate): name, code, active, how many templates and how many active templates each has.",
  args: z.object({ includeInactive: z.boolean().optional() }),
  run: async (a, ctx) => {
    const types = await listTypes(ctx.companyId, { includeInactive: !!a.includeInactive });
    return { total: types.length, items: types.map((t) => ({ id: t.id, name: t.name, code: t.code, isActive: t.isActive, templates: t._count?.templates ?? 0, activeTemplates: t.activeTemplates, scopes: t.scopes })) };
  },
});

defineTool({
  name: "list_templates",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificate_templates"],
  label: "Listing certificate templates",
  description:
    "Certificate templates, filtered by type, brand, country (ISO code, e.g. SA) or version status. Each: name, type, brand, country, scope, whether it has an active version, its field count, latest version status. " +
    "`active: true` keeps only templates with an active version.",
  args: z.object({
    certificateTypeId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
    country: z.string().length(2).optional(),
    active: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    ...pageArgs,
  }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, templates } = await listTemplates(ctx.companyId || undefined, { ...a, page: a.active ? 1 : p, limit: a.active ? 100 : limit });
    let rows = templates.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.certificateType?.code,
      brand: t.brand?.name || null,
      country: t.country,
      scope: t.scope,
      active: !!t.activeVersion,
      activeVersion: t.activeVersion ? { id: t.activeVersion.id, versionNumber: t.activeVersion.versionNumber } : null,
      latestVersion: t.latestVersion ? { id: t.latestVersion.id, versionNumber: t.latestVersion.versionNumber, status: t.latestVersion.status } : null,
      fieldCount: t.fieldCount,
      archived: !!t.archivedAt,
      ...(ctx.companyId ? {} : { companyId: t.companyId }),
    }));
    if (a.active) {
      rows = rows.filter((r) => r.active);
      return page(rows.slice((p - 1) * limit, p * limit), rows.length, { page: p, limit });
    }
    return page(rows, total, { page: p, limit });
  },
});

defineTool({
  name: "get_template",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificate_templates"],
  label: "Reading the template",
  description: "One certificate template and its versions (number, status, when). Use get_template_fields with a version id for its fields.",
  args: z.object({ templateId: id("template") }),
  run: async (a, ctx) => {
    const t = await getTemplate(a.templateId, ctx.companyId || undefined);
    return {
      id: t.id, name: t.name, type: t.certificateType, brand: t.brand?.name || null, country: t.country, scope: t.scope, activeVersionId: t.activeVersionId, archivedAt: t.archivedAt,
      versions: t.versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, status: v.status, createdAt: v.createdAt })),
    };
  },
});

defineTool({
  name: "get_template_fields",
  module: "certificates",
  risk: "read",
  permissions: ["read_certificate_templates"],
  label: "Reading template fields",
  description:
    "The fields of one template version: key, label, required, where its value comes from (source), data category, and the flags isLabResult (comes from the lab) and isBatchFact (a fact of the batch), not applicable. " +
    "Pass the version id (activeVersion.id from list_templates or get_template).",
  args: z.object({ templateVersionId: id("template version") }),
  run: async (a, ctx) => {
    const v = await getVersionDetail(a.templateVersionId, ctx.companyId || undefined);
    return {
      id: v.id, versionNumber: v.versionNumber, status: v.status, template: { id: v.template.id, name: v.template.name, scope: v.template.scope },
      fields: v.fields.map((f) => ({ key: f.key, label: f.label, required: f.required, source: f.source, dataCategory: f.dataCategory, isLabResult: f.isLabResult, isBatchFact: f.isBatchFact, notApplicable: f.notApplicable, inferencePolicy: f.inferencePolicy, mappingConfirmed: f.mappingConfirmed })),
      groups: (v.groups || []).map((g) => ({ key: g.key, label: g.label, mode: g.mode })),
    };
  },
});
