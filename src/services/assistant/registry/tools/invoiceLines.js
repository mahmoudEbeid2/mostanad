import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { id } from "./common.js";
import { assertVerbatim } from "./actions.js";
import { loadInvoice, updateItem } from "../../../certificates/invoices/invoiceService.js";
import { createProductFromLine } from "../../../certificates/invoices/newProductService.js";

// Many invoice lines in ONE card (QA 2026-11-23: one card per line, and approving line 1
// expired the other six). match_invoice_lines decides per line — match to a product /
// create a new product / ignore — and create_products_from_lines creates products for the
// lines that have none. The proposal comes from the invoice's own matcher (A3) candidates;
// the person sees every line on the card, can change rows, and presses one button.
// Each line is done on its own and reported on its own.

export const LINE_ACTIONS = ["match", "create", "ignore"];
const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const invoiceLabel = (inv) => inv.header?.invoiceNumber || `invoice of ${new Date(inv.createdAt).toISOString().slice(0, 10)}`;
const valuesArg = z.record(z.string(), z.string().max(2000)).optional().describe("create only: product fields the person gave for this line (name, productCode, …)");
const lineRow = z.object({
  lineNo: z.number().int().min(1),
  action: z.enum(LINE_ACTIONS),
  productId: z.string().uuid().optional().describe("match only: the product (from search_products or the line's candidates)"),
  values: valuesArg,
});

/** The rows checked against the invoice, for the card and the run. → { inv, rows: [{ row, item, product }] } */
export async function checkLines(invoiceId, lines, companyId) {
  const inv = await loadInvoice(invoiceId, companyId);
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id }, include: { product: { select: { id: true, name: true, productCode: true } } } });
  const byNo = new Map(items.map((i) => [i.lineNo, i]));
  const seen = new Set();
  const out = [];
  for (const row of lines) {
    if (seen.has(row.lineNo)) throw new ToolError(`Line ${row.lineNo} is listed twice`, "duplicate_line");
    seen.add(row.lineNo);
    const item = byNo.get(row.lineNo);
    if (!item) throw new ToolError(`Invoice ${invoiceLabel(inv)} has no line ${row.lineNo}`, "not_found");
    let product = null;
    if (row.action === "match") {
      if (!row.productId) throw new ToolError(`Line ${row.lineNo}: which product? (productId)`, "product_required");
      product = await prisma.product.findFirst({ where: { id: row.productId, companyId: inv.companyId }, select: { id: true, name: true, productCode: true } });
      if (!product) throw new ToolError(`Line ${row.lineNo}: product not found in this invoice's company`, "not_found");
    }
    if (row.action === "create" && item.matchStatus !== "needs_match") throw new ToolError(`Line ${row.lineNo} is already ${item.matchStatus} — nothing to create`, "line_not_open");
    out.push({ row, item, product });
  }
  return { inv, rows: out };
}

/** Products with the line's printed name in OTHER companies (system users): said on the card, never matched across companies. */
async function elsewhere(inv, names) {
  if (!names.length) return new Map();
  const hits = await prisma.product.findMany({ where: { companyId: { not: inv.companyId }, name: { in: names, mode: "insensitive" } }, select: { name: true, company: { select: { name: true } } }, take: 50 });
  const m = new Map();
  for (const h of hits) m.set(h.name.toLowerCase(), [...new Set([...(m.get(h.name.toLowerCase()) || []), h.company.name])]);
  return m;
}

function rowText({ row, item, product }, other) {
  const printed = item.data?.name || "—";
  if (row.action === "match") return `→ ${product.name}${product.productCode ? ` (${product.productCode})` : ""}${item.product && item.product.id !== product.id ? ` (now ${item.product.name})` : ""}`;
  if (row.action === "ignore") return "→ ignore this line";
  const there = other.get(String(printed).toLowerCase());
  return `→ new product «${row.values?.name || printed}»${there ? ` — exists in ${there.join(", ")} (another company: can't be matched from here)` : ""}`;
}

async function preview(a, ctx, title) {
  const { inv, rows } = await checkLines(a.invoiceId, a.lines, ctx.companyId);
  const other = ctx.isSystem ? await elsewhere(inv, rows.filter((r) => r.row.action === "create").map((r) => r.item.data?.name).filter(Boolean)) : new Map();
  const n = (k) => rows.filter((r) => r.row.action === k).length;
  return {
    title,
    summary: `Invoice ${invoiceLabel(inv)}: ${[n("match") && `${n("match")} matched to products`, n("create") && `${n("create")} new products created`, n("ignore") && `${n("ignore")} ignored`].filter(Boolean).join(", ")}. Each line is done on its own.`,
    runLabel: "Apply to all lines",
    details: rows.map((r) => ({ label: `Line ${r.row.lineNo} · ${r.item.data?.name || "—"}`, value: rowText(r, other) })),
    aiCalls: null,
    missing: [],
  };
}

async function run(a, ctx) {
  const { inv, rows } = await checkLines(a.invoiceId, a.lines, ctx.companyId);
  const results = [];
  for (const { row, item } of rows) {
    try {
      if (row.action === "match") await updateItem(inv.id, item.id, ctx.companyId, { productId: row.productId }, userIdOf(ctx));
      else if (row.action === "ignore") await updateItem(inv.id, item.id, ctx.companyId, { ignored: true }, userIdOf(ctx));
      else {
        const out = await createProductFromLine(inv.id, item.id, ctx.companyId, { mode: "needed", name: item.data?.name, ...(row.values || {}) }, userIdOf(ctx));
        const p = out.product || out;
        results.push({ lineNo: row.lineNo, action: "create", ok: true, productId: p.id, name: p.name, ref: p.id ? { type: "product", id: p.id, name: p.name } : null });
        continue;
      }
      results.push({ lineNo: row.lineNo, action: row.action, ok: true });
    } catch (err) {
      results.push({ lineNo: row.lineNo, action: row.action, ok: false, error: err.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return { invoiceId: inv.id, done: results.length - failed.length, failed: failed.length, results, link: `/invoices/${inv.id}`, ref: { type: "invoice", id: inv.id, name: invoiceLabel(inv) } };
}

const guard = (a, ctx) => a.lines.forEach((r) => Object.entries(r.values || {}).forEach(([k, v]) => assertVerbatim(k, v, ctx)));

defineTool({
  name: "match_invoice_lines",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices", "create_products"],
  label: "Matching the invoice lines",
  description:
    "Proposes ONE card for many lines of an invoice: per line match to a product, create a new product, or ignore. Use it to match lines (\"طابقهم\", \"match them\") — never ask line by line. " +
    "Omit `lines` and code proposes them from the invoice's matcher (its product candidates; no good candidate → create). The person can change rows on the card.",
  args: z.object({ invoiceId: id("invoice"), lines: z.array(lineRow).min(1).max(100) }),
  guard,
  preview: (a, ctx) => preview(a, ctx, `Invoice lines`),
  run,
});

defineTool({
  name: "create_products_from_lines",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices", "create_products"],
  label: "Creating products from the lines",
  description:
    "Proposes ONE card that creates a new product for each listed invoice line that has none (the 'New product' flow, in the invoice's company), each matched to its line. lines: [{ lineNo, values? }]; omit to take every unmatched line. " +
    "Never batch numbers, dates or lab results.",
  args: z.object({ invoiceId: id("invoice"), lines: z.array(z.object({ lineNo: z.number().int().min(1), values: valuesArg })).min(1).max(100) }),
  guard: (a, ctx) => guard({ lines: a.lines.map((r) => ({ ...r, action: "create" })) }, ctx),
  preview: (a, ctx) => preview({ ...a, lines: a.lines.map((r) => ({ ...r, action: "create" })) }, ctx, "New products from invoice lines"),
  run: (a, ctx) => run({ ...a, lines: a.lines.map((r) => ({ ...r, action: "create" })) }, ctx),
});
