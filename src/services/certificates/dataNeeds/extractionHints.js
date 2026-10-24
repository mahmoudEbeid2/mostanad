import { prisma } from "../../../lib/prisma.js";
import { TEMPLATE_TOKEN_RE } from "../templates/sourceCatalogue.js";
import { INVOICE_HEADER_FIELDS, INVOICE_ITEM_FIELDS } from "../invoices/invoiceSchema.js";

// The extractor is told what the company's active templates read from
// invoices (plan.md §6.3), so it looks for those columns specifically —
// still in the single extraction call. Built from the active versions' field
// sources (item.* / invoice.*, placeholders included) and their per-batch
// fields (batch_data: lab results a supplier sometimes prints on the invoice).
// → { line: [{ path, label, synonyms }], header: [...], perLine: [labels] }

export async function extractionHints(companyId) {
  const templates = await prisma.certificateTemplate.findMany({ where: { companyId, archivedAt: null, activeVersionId: { not: null } }, select: { activeVersionId: true } });
  if (!templates.length) return null;
  const fields = await prisma.templateField.findMany({ where: { versionId: { in: templates.map((t) => t.activeVersionId) } }, select: { source: true, label: true, dataCategory: true, isLabResult: true, groupKey: true } });
  const line = new Set();
  const header = new Set();
  const perLine = new Set();
  for (const f of fields) {
    const s = f.source || {};
    const refs = s.kind === "template" ? [...String(s.template || "").matchAll(TEMPLATE_TOKEN_RE)].map((m) => ({ kind: m[1], path: m[2] })) : [{ kind: s.kind, path: s.path }];
    for (const r of refs) {
      if (r.kind === "item" && r.path) line.add(r.path.split(/[.[]/)[0]);
      if (r.kind === "invoice" && r.path) header.add(r.path.split(/[.[]/)[0]);
    }
    if ((f.dataCategory === "batch_data" || f.isLabResult) && !f.groupKey && f.label) perLine.add(f.label.replace(/\s+result$/i, "").trim());
  }
  const describe = (defs, set) => defs.filter((d) => set.has(d.path) && d.path !== "lineNo").map((d) => ({ path: d.path, label: d.label, synonyms: d.synonyms || [] }));
  const extraPaths = [...line].filter((p) => p === "extra");
  const out = { line: describe(INVOICE_ITEM_FIELDS, line), header: describe(INVOICE_HEADER_FIELDS, header), perLine: [...perLine] };
  if (extraPaths.length) out.perLine.push(...fields.filter((f) => f.source?.kind === "item" && /^extra\b/.test(f.source.path || "")).map((f) => f.label));
  return out.line.length || out.header.length || out.perLine.length ? out : null;
}
