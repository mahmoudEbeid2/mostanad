import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { getTool, allTools } from "../registry/index.js";
import { loadAttachment } from "../attachments.js";
import { loadInvoice } from "../../certificates/invoices/invoiceService.js";
import { GENERATABLE } from "../../certificates/generation/batchService.js";
import { getNeeds } from "../../certificates/dataNeeds/dataNeedsService.js";

// Operation specs (drafts): for every write tool, what each argument is and how it can be
// filled, and what must be true before the operation can run.
//
// One source of truth: a field's type, whether it is required, allowed values and format come
// from the tool's own zod args — the schema executeApproved parses with (create_product's are the
// products API's validator itself). A spec only adds HOW a value may be found:
//   context — the current page / this message's files, deterministically
//   lookup  — a read tool, as the caller; only a single result is filled, several become a choice
//   user    — only the person can give it (their own words, or the form card)
// and the prerequisites, each with the tools that satisfy it. drafts.test.js fails when a write
// tool has no spec, or a spec names a field its tool doesn't have.

const MAX_OPTIONS = 12;
const invoiceLabel = (inv) => inv.header?.invoiceNumber || `invoice of ${new Date(inv.createdAt).toISOString().slice(0, 10)}`;
const one = (options, evidence) => (options.length === 1 ? { value: options[0].value, display: options[0].label, evidence } : options.length ? { options: options.slice(0, MAX_OPTIONS) } : null);

// ── resolvers ───────────────────────────────────────────────────────────────
// resolve(d, hint) → { value, display, evidence } | { options: [{ value, label }] } | null
// verify(value, d) → { display } (throws a message string's Error when the value isn't valid here)
// d = { ctx (the registry ctx), companyId, fields (name → value), run(tool, args) → read tool data }

/** The open page's entity, when it is of this type. */
const page = (type) => ({
  kind: "context",
  source: "page",
  resolve: async (d) => (d.ctx.page?.entityType === type && d.ctx.page.entityId ? { value: d.ctx.page.entityId, evidence: `the ${type} page you are on` } : null),
});

const invoice = {
  kind: "lookup",
  tool: "search_invoices",
  resolve: async (d, hint) => {
    if (!hint) return null;
    const data = await d.run("search_invoices", { q: hint, limit: 10 });
    return one((data?.items || []).map((i) => ({ value: i.id, label: `${i.invoiceNumber || "invoice"}${i.customer ? ` · ${i.customer}` : ""} · ${i.status}` })), `search_invoices: "${hint}"`);
  },
  verify: async (value, d) => ({ display: invoiceLabel(await loadInvoice(value, d.companyId)) }),
};

/** An invoice line: the lines get_invoice lists (open = only lines still needing a product). */
const line = ({ open }) => ({
  kind: "lookup",
  tool: "get_invoice",
  needs: ["invoiceId"],
  resolve: async (d) => {
    const data = await d.run("get_invoice", { invoiceId: d.fields.invoiceId });
    const lines = (data?.lines || []).filter((l) => !open || l.matchStatus === "needs_match");
    return one(lines.map((l) => ({ value: l.lineNo, label: `Line ${l.lineNo} · ${l.name || "—"}${l.matchStatus === "needs_match" ? " · needs a product" : ""}` })), open ? "the invoice's only line that needs a product" : "the invoice's only line");
  },
  verify: async (value, d) => {
    const inv = await loadInvoice(d.fields.invoiceId, d.companyId);
    const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: inv.id, lineNo: value }, select: { lineNo: true, data: true, matchStatus: true } });
    if (!item) throw new Error(`Invoice ${invoiceLabel(inv)} has no line ${value}`);
    if (open && item.matchStatus !== "needs_match") throw new Error(`Line ${value} is already ${item.matchStatus}`);
    return { display: `Line ${item.lineNo} · ${item.data?.name || "—"}` };
  },
});

/** A product: search_products with the hint, or else the invoice line's printed name. */
const product = {
  kind: "lookup",
  tool: "search_products",
  resolve: async (d, hint) => {
    let q = hint;
    let from = "";
    if (!q && d.fields.invoiceId && d.fields.lineNo) {
      const item = await prisma.invoiceItem.findFirst({ where: { invoice: { id: d.fields.invoiceId, companyId: d.companyId }, lineNo: d.fields.lineNo }, select: { data: true } });
      q = item?.data?.name || null;
      from = " (the name printed on the line)";
    }
    if (!q) return null;
    const data = await d.run("search_products", { queries: [String(q)] });
    const results = data?.results || [];
    const options = results.map((r) => ({ value: r.productId, label: `${r.name}${r.productCode ? ` · ${r.productCode}` : ""}` }));
    // only an exact, single match is filled; close or several are a choice for the person
    if (data?.verdict === "exact" && !data.several && options.length) return { value: options[0].value, display: options[0].label, evidence: `search_products: exact match for "${q}"${from}` };
    return options.length ? { options: options.slice(0, MAX_OPTIONS) } : null;
  },
  verify: async (value, d) => {
    const p = await prisma.product.findFirst({ where: { id: value, companyId: d.companyId }, select: { name: true, productCode: true } });
    if (!p) throw new Error("Product not found!");
    return { display: `${p.name}${p.productCode ? ` · ${p.productCode}` : ""}` };
  },
};

const brand = {
  kind: "lookup",
  tool: "list_brands",
  resolve: async (d, hint) => {
    const data = await d.run("list_brands", { ...(hint ? { q: hint } : {}), limit: 25 });
    return one((data?.items || []).map((b) => ({ value: b.id, label: b.name })), hint ? `list_brands: "${hint}"` : "the company's only brand");
  },
  verify: async (value, d) => {
    const b = await prisma.brand.findFirst({ where: { id: value, companyId: d.companyId }, select: { name: true } });
    if (!b) throw new Error("Brand not found in this company");
    return { display: b.name };
  },
};

const category = {
  kind: "lookup",
  tool: "list_categories",
  resolve: async (d, hint) => {
    const data = await d.run("list_categories", { ...(hint ? { q: hint } : {}), limit: 25 });
    return one((data?.items || []).map((c) => ({ value: c.id, label: c.name })), hint ? `list_categories: "${hint}"` : "the only category");
  },
  verify: async (value) => {
    const c = await prisma.category.findUnique({ where: { id: value }, select: { name: true } });
    if (!c) throw new Error("Category not found");
    return { display: c.name };
  },
};

/** Certificate types (several may be picked): offered as a choice, never guessed. */
const certificateTypes = {
  kind: "lookup",
  tool: "list_certificate_types",
  multiple: true,
  resolve: async (d) => {
    const data = await d.run("list_certificate_types", {});
    const options = (data?.items || []).filter((t) => t.isActive).map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }));
    return options.length ? { options: options.slice(0, MAX_OPTIONS) } : null;
  },
  verify: async (value, d) => {
    const types = await prisma.certificateType.findMany({ where: { id: { in: value }, companyId: d.companyId, isActive: true }, select: { id: true, code: true } });
    if (types.length !== new Set(value).size) throw new Error("A certificate type isn't an active type of this company");
    return { display: types.map((t) => t.code).join(", ") };
  },
};

/** A file attached in this conversation: this message's file, or the conversation's only one. */
const attachment = ({ pdfOnly = false, many = false } = {}) => ({
  kind: "context",
  source: "files",
  multiple: many,
  resolve: async (d) => {
    const fits = (a) => !pdfOnly || a.mimeType === "application/pdf";
    const now = (d.ctx.attachments || []).filter(fits);
    if (many && now.length) return { value: now.map((a) => a.id), display: now.map((a) => a.name).join(", "), evidence: "the files in your message" };
    if (now.length === 1) return { value: many ? [now[0].id] : now[0].id, display: now[0].name, evidence: "the file in your message" };
    const all = d.ctx.conversationId && d.companyId ? (await prisma.assistantAttachment.findMany({ where: { conversationId: d.ctx.conversationId, companyId: d.companyId }, orderBy: { createdAt: "desc" }, take: 20 })).filter(fits) : [];
    const options = (now.length ? now : all).map((a) => ({ value: many ? [a.id] : a.id, label: a.name }));
    if (options.length === 1) return { value: options[0].value, display: options[0].label, evidence: "the only file in this conversation" };
    return options.length ? { options } : null;
  },
  verify: async (value, d) => {
    const ids = Array.isArray(value) ? value : [value];
    const files = await Promise.all(ids.map((id) => loadAttachment(id, { conversationId: d.ctx.conversationId, companyId: d.companyId })));
    if (pdfOnly && files.some((f) => f.mimeType !== "application/pdf")) throw new Error("This needs a PDF");
    return { display: files.map((f) => f.name).join(", ") };
  },
});

/** Only the person can give it: their own words (checked verbatim) or the form card. */
const user = (extra = {}) => ({ kind: "user", ...extra });

// ── prerequisites ───────────────────────────────────────────────────────────
// check(d) → null when met, else { detail }. fix: the tools (each its own draft and card) that satisfy it.
const linesMatched = {
  key: "lines_matched",
  label: "Every invoice line is matched to a product (or ignored)",
  needs: ["invoiceId"],
  fix: ["match_invoice_line", "create_product_from_line"],
  check: async (d) => {
    const open = await prisma.invoiceItem.findMany({ where: { invoice: { id: d.fields.invoiceId, companyId: d.companyId }, matchStatus: "needs_match" }, orderBy: { lineNo: "asc" }, select: { lineNo: true, data: true } });
    return open.length ? { detail: `${open.length === 1 ? "Line" : "Lines"} ${open.map((l) => `${l.lineNo} (${l.data?.name || "—"})`).join(", ")} ${open.length === 1 ? "needs" : "need"} a product` } : null;
  },
};
const someMatched = {
  key: "some_matched",
  label: "At least one invoice line is matched to a product",
  needs: ["invoiceId"],
  fix: ["match_invoice_line", "create_product_from_line"],
  check: async (d) => ((await prisma.invoiceItem.count({ where: { invoice: { id: d.fields.invoiceId, companyId: d.companyId }, matchStatus: "matched" } })) ? null : { detail: "No line is matched to a product yet" }),
};
const invoiceReady = {
  key: "invoice_ready",
  label: "The invoice is confirmed (ready)",
  needs: ["invoiceId"],
  fix: ["confirm_invoice"],
  check: async (d) => {
    const inv = await loadInvoice(d.fields.invoiceId, d.companyId);
    return GENERATABLE.includes(inv.status) ? null : { detail: `Invoice ${invoiceLabel(inv)} is ${inv.status}` };
  },
};
const inReview = {
  key: "in_review",
  label: "The invoice is under review",
  needs: ["invoiceId"],
  fix: [],
  check: async (d) => {
    const inv = await loadInvoice(d.fields.invoiceId, d.companyId);
    return inv.status === "review" ? null : { detail: `Invoice ${invoiceLabel(inv)} is ${inv.status}; only an invoice under review is confirmed` };
  },
};
// lab results and batch facts are flagged on the drafts by design (only the lab or a COA fills them): not a blocker
const dataComplete = {
  key: "data_complete",
  label: "No required certificate value is missing (lab results and batch facts are flagged instead)",
  needs: ["invoiceId"],
  fix: ["prepare_certificates", "upload_supplier_coa"],
  check: async (d) => {
    let needs;
    try {
      needs = await getNeeds(d.fields.invoiceId, d.companyId);
    } catch (err) {
      return { detail: `The data check can't be read yet: ${err.message}` };
    }
    const open = needs.certificates.flatMap((c) => c.needs.filter((n) => n.required && n.status === "missing" && !n.labResult && !n.batchFact));
    return open.length ? { detail: `${open.length} required value${open.length === 1 ? "" : "s"} missing: ${[...new Set(open.map((n) => n.label))].slice(0, 6).join(", ")}` } : null;
  },
};
const lineOpen = {
  key: "line_open",
  label: "The line still needs a product",
  needs: ["invoiceId", "lineNo"],
  fix: [],
  check: async (d) => {
    const item = await prisma.invoiceItem.findFirst({ where: { invoice: { id: d.fields.invoiceId, companyId: d.companyId }, lineNo: d.fields.lineNo }, select: { matchStatus: true } });
    return !item || item.matchStatus === "needs_match" ? null : { detail: `Line ${d.fields.lineNo} is already ${item.matchStatus}` };
  },
};

// ── watch: what the operation acts on, fingerprinted when its card is shown ──
const invoiceWatch = async (f, d) => {
  if (!f.invoiceId) return null;
  const inv = await prisma.invoice.findFirst({ where: { id: f.invoiceId, companyId: d.companyId }, select: { status: true, updatedAt: true } });
  return inv ? `invoice:${inv.status}:${inv.updatedAt.toISOString()}` : "invoice:gone";
};
const productWatch = async (f, d) => {
  if (!f.productId) return null;
  const p = await prisma.product.findFirst({ where: { id: f.productId, companyId: d.companyId }, select: { updatedAt: true } });
  return p ? `product:${p.updatedAt.toISOString()}` : "product:gone";
};

// ── the specs ───────────────────────────────────────────────────────────────
const INVOICE = [page("invoice"), invoice];
export const SPECS = {
  upload_invoice: { title: "Upload an invoice", fields: { attachmentId: [attachment()], certificateTypeIds: [certificateTypes], brandId: [brand], country: [user()] } },
  match_invoice_line: {
    title: "Match an invoice line to a product",
    key: ["invoiceId", "lineNo"],
    fields: { invoiceId: INVOICE, lineNo: [line({ open: true })], productId: [product] },
    watch: invoiceWatch,
    errors: [[/line/i, "lineNo"], [/product/i, "productId"], [/invoice/i, "invoiceId"]],
  },
  create_product_from_line: {
    title: "Create a product from an invoice line",
    key: ["invoiceId", "lineNo"],
    fields: { invoiceId: INVOICE, lineNo: [line({ open: true })], values: [user()] },
    prerequisites: [lineOpen],
    watch: invoiceWatch,
    errors: [[/line/i, "lineNo"], [/invoice/i, "invoiceId"]],
  },
  confirm_invoice: { title: "Confirm the invoice", key: ["invoiceId"], fields: { invoiceId: INVOICE }, prerequisites: [inReview, linesMatched], watch: invoiceWatch, errors: [[/line|match/i, "invoiceId"]] },
  prepare_certificates: { title: "Prepare certificates", key: ["invoiceId"], fields: { invoiceId: INVOICE }, prerequisites: [someMatched], watch: invoiceWatch },
  generate_certificates: {
    title: "Generate certificates",
    key: ["invoiceId"],
    fields: { invoiceId: INVOICE, certificateTypeIds: [certificateTypes] },
    prerequisites: [linesMatched, invoiceReady, dataComplete],
    watch: invoiceWatch,
    errors: [[/type/i, "certificateTypeIds"], [/invoice|template/i, "invoiceId"]],
  },
  upload_supplier_coa: { title: "Read supplier COAs", key: ["invoiceId"], fields: { invoiceId: INVOICE, attachmentIds: [attachment({ many: true })] }, watch: invoiceWatch },
  upload_catalogue: { title: "Upload a catalogue", fields: { attachmentId: [attachment({ pdfOnly: true })], edition: [user()], manufacturer: [user()], brandId: [brand] }, errors: [[/pdf|file/i, "attachmentId"], [/brand/i, "brandId"]] },
  verify_label: { title: "Check a label", fields: { attachmentId: [attachment()], country: [user()] } },
  upload_label: { title: "Add a reference label", fields: { attachmentId: [attachment()], country: [user()], brandId: [brand] }, errors: [[/exists/i, "attachmentId"]] },
  update_product_fields: { title: "Update product fields", key: ["productId"], fields: { productId: [page("product"), product], changes: [user({ form: "changes" })] }, watch: productWatch, errors: [[/product/i, "productId"], [/batch|lab|field/i, "changes"]] },
  create_product: {
    title: "Add a product",
    // the product screens and certificates need these; the API alone would accept a name only
    alsoRequire: ["brandId", "categoryId", "activeIngredients"],
    fields: {
      name: [user()], productCode: [user()], description: [user()], indications: [user()], targetSpecies: [user()], physicalForm: [user()], appearance: [user()],
      activeIngredients: [user({ form: "ingredients" })], dosage: [user()], mixingInstructions: [user()], withdrawalPeriod: [user()], contraindications: [user()], userSafety: [user()],
      storage: [user()], packaging: [user()], registrationNumber: [user()], origin: [user()], producer: [user()], categoryId: [category], brandId: [brand],
    },
    errors: [[/brand/i, "brandId"], [/categor/i, "categoryId"], [/name/i, "name"], [/ingredient|concentration/i, "activeIngredients"]],
  },
};

// ── a spec as the draft service uses it ─────────────────────────────────────
const LABELS = { invoiceId: "Invoice", lineNo: "Line", productId: "Product", brandId: "Brand", categoryId: "Category", attachmentId: "File", attachmentIds: "Files", certificateTypeIds: "Certificate types", activeIngredients: "Composition", companyId: "Company" };
export const labelOf = (name) => LABELS[name] || name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Field metadata from the tool's zod args (type, required, enum, format) + how it may be resolved. */
export function specFor(toolName) {
  const tool = getTool(toolName);
  if (!tool || tool.risk === "read") return null;
  const spec = SPECS[toolName] || { title: tool.label || toolName, fields: {} }; // a tool without a spec (tests): every field from the user
  const json = z.toJSONSchema(tool.args, { target: "openapi-3.0", unrepresentable: "any" });
  const required = new Set(json.required || []);
  const fields = Object.entries(json.properties || {}).map(([name, s]) => {
    const items = s.items || {};
    const resolvers = spec.fields[name] || [user()];
    return {
      name,
      label: labelOf(name),
      required: required.has(name) || (spec.alsoRequire || []).includes(name),
      type: s.type || (s.anyOf ? "string" : "string"),
      enum: s.enum || items.enum || null,
      itemType: items.type || null,
      format: s.format || null,
      description: s.description || null,
      schema: tool.args.shape[name],
      resolvers,
      how: resolvers.map((r) => (r.kind === "lookup" ? `lookup (${r.tool})` : r.kind === "context" ? r.source : "user")),
      multiple: resolvers.some((r) => r.multiple) || s.type === "array",
      form: resolvers.find((r) => r.form)?.form || null,
    };
  });
  return { tool, title: spec.title, key: spec.key || [], fields, prerequisites: spec.prerequisites || [], watch: spec.watch || null, errors: spec.errors || [] };
}

/** Write tools with no spec (the registry check in drafts.test.js). */
export const unspecified = () => allTools().filter((t) => t.risk !== "read" && !t.name.startsWith("test_") && !SPECS[t.name]).map((t) => t.name);
