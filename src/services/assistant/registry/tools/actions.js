import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { loadAttachment, attachmentFile } from "../../attachments.js";
import { pdfText } from "../../../certificates/labResults/coaService.js";
import { uploadInvoice, loadInvoice, updateItem, updateInvoice, confirmInvoice } from "../../../certificates/invoices/invoiceService.js";
import { newProductDraft, createProductFromLine } from "../../../certificates/invoices/newProductService.js";
import { startPrepare } from "../../../certificates/prepare/prepareService.js";
import { startGeneration } from "../../../certificates/generation/batchService.js";
import { previewPlan as planOf } from "../../../certificates/generation/planService.js";
import { getNeeds } from "../../../certificates/dataNeeds/dataNeedsService.js";
import { listTypes } from "../../../certificates/types/certificateTypeService.js";
import { uploadCoas } from "../../../certificates/labResults/coaService.js";
import { uploadCatalogue } from "../../../catalogues/catalogueService.js";
import { startLabelVerification, queueReferenceLabel, uploadedOn } from "../../../label/labelUploads.js";
import { updateProduct, createProduct } from "../../../productService.js";
import { createProductSchema } from "../../../../validators/productValidator.js";
import { id } from "./common.js";
import { certificatesOfBatch } from "../../../certificates/generation/batchService.js";

// C2 actions. A model call to any of these only PROPOSES a confirmation card
// (preview); run() happens after the person presses Run, with the card's stored
// args (registry.executeApproved). Each one calls the existing service, as the
// caller, in one explicit company.
//
// Never here, by design (registry.FORBIDDEN_ACTIONS): finalize certificates,
// delete anything, activate templates, apply catalogue changes, users / roles /
// companies.

const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const companyName = async (id) => (await prisma.company.findUnique({ where: { id }, select: { name: true } }))?.name || id;
const invoiceLabel = (inv) => inv.header?.invoiceNumber || `invoice of ${inv.createdAt.toISOString().slice(0, 10)}`;
const attachmentArg = z.string().uuid().describe("The id of a file attached in this conversation (shown in the user's message as [attached: …])");

async function attachment(args, ctx, idKey = "attachmentId") {
  return loadAttachment(args[idKey], { conversationId: ctx.conversationId, companyId: ctx.companyId });
}
const fileLine = (a) => `${a.name} · ${mb(a.sizeBytes)}${a.pages ? ` · ${a.pages} page${a.pages === 1 ? "" : "s"}` : ""}`;

async function lineOf(invoiceId, lineNo, companyId) {
  const inv = await loadInvoice(invoiceId, companyId);
  const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: inv.id, lineNo }, include: { product: { select: { id: true, name: true, productCode: true } } } });
  if (!item) throw new ToolError(`Invoice ${invoiceLabel(inv)} has no line ${lineNo}`, "not_found");
  return { inv, item };
}

// ── protected data ──────────────────────────────────────────────────────────
// Lab results and batch facts (batch / lot, production / expiry dates) are only
// ever written when the value is in the person's own message, verbatim — or read
// from a supplier COA by the existing verifier (upload_supplier_coa). Enforced
// here, in the tool, not in the prompt.
export const PROTECTED_KEY = /(batch|lot[_ ]?(no|number)?$|^lot|expir|production|manufactur\w*[_ ]?date|best[_ ]?before|result)/i;

export function assertVerbatim(key, value, ctx) {
  if (!PROTECTED_KEY.test(key)) return;
  const v = String(value ?? "").trim();
  const said = (ctx.userTexts || []).some((t) => v && String(t).includes(v));
  if (!said) {
    throw new ToolError(
      `"${key}" is a lab result or batch fact (batch/lot, production or expiry date). I only write those when you type the value yourself in this chat, or when a supplier COA is read — "${v || "(empty)"}" isn't in your messages, so I won't fill it.`,
      "protected_value"
    );
  }
}

// ── files ───────────────────────────────────────────────────────────────────
defineTool({
  name: "inspect_attachment",
  module: "files",
  core: true,
  risk: "read",
  label: "Looking at the file",
  description:
    "What an attached file is: name, type, size, pages and — for a PDF with a text layer — the start of its text (no AI). Use it with the user's words to decide whether it is an invoice, a catalogue, " +
    "a label, a certificate template or a supplier COA / lab report, then propose the matching action. If it is unclear, ask.",
  args: z.object({ attachmentId: attachmentArg }),
  run: async (a, ctx) => {
    const att = await attachment(a, ctx);
    let textSample = null;
    let textPages = null;
    if (att.mimeType === "application/pdf") {
      try {
        const { buffer } = await attachmentFile(att);
        const t = await pdfText(buffer);
        textSample = t.text.slice(0, 1500) || null;
        textPages = t.pages;
      } catch (err) {
        textSample = `(text not readable: ${err.message})`;
      }
    }
    return { id: att.id, name: att.name, mimeType: att.mimeType, size: mb(att.sizeBytes), pages: att.pages ?? textPages, hasTextLayer: !!textSample && !textSample.startsWith("("), textSample };
  },
});

// ── invoices ────────────────────────────────────────────────────────────────
defineTool({
  name: "upload_invoice",
  module: "invoices",
  risk: "write",
  permissions: ["create_invoices"],
  label: "Uploading the invoice",
  description:
    "Proposes uploading an attached invoice (PDF or image) for the current company: it is read in the background (about 3 AI calls), its lines matched to products, and the data check run. " +
    "certificateTypeIds: the certificate types to make (from list_certificate_types); omit for the company's default. Shows the user a card to approve; nothing happens until they do.",
  args: z.object({
    attachmentId: attachmentArg,
    certificateTypeIds: z.array(z.string().uuid()).max(20).optional(),
    brandId: z.string().uuid().optional(),
    country: z.string().length(2).optional().describe("Destination, ISO alpha-2 (e.g. SA)"),
  }),
  preview: async (a, ctx) => {
    const att = await attachment(a, ctx);
    if (att.sizeBytes > 15 * 1024 * 1024) throw new ToolError(`${att.name} is ${mb(att.sizeBytes)}; invoices are limited to 15 MB`, "too_large");
    const types = await listTypes(ctx.companyId);
    const chosen = a.certificateTypeIds?.length ? a.certificateTypeIds.map((t) => types.find((x) => x.id === t) || (() => { throw new ToolError(`Certificate type ${t} isn't an active type of this company`, "bad_type"); })()) : null;
    const brand = a.brandId ? await prisma.brand.findFirst({ where: { id: a.brandId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.brandId && !brand) throw new ToolError("Brand not found!", "not_found");
    return {
      title: "Upload invoice",
      summary: "The invoice is read in the background, its lines matched to your products and the data check run. Nothing is generated yet.",
      runLabel: "Upload",
      details: [
        { label: "File", value: fileLine(att) },
        { label: "Company", value: await companyName(ctx.companyId) },
        { label: "Certificates to make", value: chosen ? chosen.map((t) => t.code).join(", ") : "the company's default types" },
        ...(brand ? [{ label: "Brand", value: brand.name }] : []),
        ...(a.country ? [{ label: "Destination", value: a.country }] : []),
      ],
      aiCalls: "Reads the invoice · about 3 AI calls",
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await attachment(a, ctx);
    const out = await uploadInvoice({ companyId: ctx.companyId, userId: userIdOf(ctx), file: await attachmentFile(att), brandId: a.brandId || null, country: a.country || null, ...(a.certificateTypeIds ? { certificateTypeIds: a.certificateTypeIds } : {}) });
    return { invoiceId: out.invoiceId, taskId: out.taskId, link: `/invoices/${out.invoiceId}`, ref: { type: "invoice", id: out.invoiceId, name: att.name } };
  },
});

defineTool({
  name: "match_invoice_line",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices"],
  label: "Matching the line",
  description: "Proposes matching one invoice line (by line number) to a product (from search_products). Shows a card; nothing happens until the user approves.",
  args: z.object({ invoiceId: id("invoice"), lineNo: z.number().int().min(1), productId: id("product") }),
  preview: async (a, ctx) => {
    const { inv, item } = await lineOf(a.invoiceId, a.lineNo, ctx.companyId);
    const product = await prisma.product.findFirst({ where: { id: a.productId, companyId: ctx.companyId }, select: { name: true, productCode: true } });
    if (!product) throw new ToolError("Product not found!", "not_found");
    return {
      title: `Match line ${item.lineNo}`,
      summary: `Line ${item.lineNo} of invoice ${invoiceLabel(inv)} will be matched to ${product.name}.`,
      runLabel: "Match",
      details: [
        { label: "Invoice", value: invoiceLabel(inv) },
        { label: "Line", value: `${item.lineNo} · ${item.data?.name || "—"}` },
        { label: "Product", value: `${item.product ? `${item.product.name} → ` : ""}${product.name}${product.productCode ? ` (${product.productCode})` : ""}` },
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const { inv, item } = await lineOf(a.invoiceId, a.lineNo, ctx.companyId);
    await updateItem(inv.id, item.id, ctx.companyId, { productId: a.productId }, userIdOf(ctx));
    return { invoiceId: inv.id, lineNo: item.lineNo, productId: a.productId, link: `/invoices/${inv.id}` };
  },
});

const NEW_PRODUCT_FIELDS = ["name", "productCode", "description", "indications", "physicalForm", "appearance", "dosage", "mixingInstructions", "withdrawalPeriod", "contraindications", "storage", "packaging", "registrationNumber", "origin", "producer", "routeOfAdmin", "dosageForm", "strength", "productType", "prescriptionStatus", "validity", "compositionBasis"]; // 28 Nov: validity / basis — "غيّر الصلاحية لـ 24 شهر" had no field to land on

defineTool({
  name: "create_product_from_line",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices", "create_products"],
  label: "Creating the product",
  description:
    "Proposes creating a product from an unmatched invoice line (the 'New product' flow): the product is created in the invoice's company and matched to the line. values: product fields the user gave " +
    `(${NEW_PRODUCT_FIELDS.join(", ")}). The card lists the fields the line's certificates need that are still empty. Never batch numbers, dates or lab results.`,
  args: z.object({ invoiceId: id("invoice"), lineNo: z.number().int().min(1), values: z.strictObject(Object.fromEntries(NEW_PRODUCT_FIELDS.map((f) => [f, z.string().max(2000).optional()]))).optional() }),
  guard: (a, ctx) => Object.entries(a.values || {}).forEach(([k, v]) => assertVerbatim(k, v, ctx)),
  preview: async (a, ctx) => {
    const { inv, item } = await lineOf(a.invoiceId, a.lineNo, ctx.companyId);
    if (item.matchStatus !== "needs_match") throw new ToolError(`Line ${item.lineNo} is already ${item.matchStatus}`, "line_not_open");
    const draft = await newProductDraft(inv.id, item.id, ctx.companyId);
    const values = { name: item.data?.name || undefined, ...(a.values || {}) };
    const missing = draft.neededFields.filter((f) => !values[f.path] && !draft.prefill?.[f.path]).map((f) => f.label);
    return {
      title: "Create product",
      summary: `A new product is created in ${draft.companyName} and matched to line ${item.lineNo}. Batch, quantity and dates stay on the line.`,
      runLabel: "Create",
      details: [
        { label: "Invoice", value: `${invoiceLabel(inv)} · line ${item.lineNo}` },
        ...Object.entries(values).filter(([, v]) => v).map(([k, v]) => ({ label: k, value: String(v) })),
      ],
      aiCalls: null,
      missing: missing.length ? [`Still empty for this line's certificates: ${missing.join(", ")}`] : [],
    };
  },
  run: async (a, ctx) => {
    const { inv, item } = await lineOf(a.invoiceId, a.lineNo, ctx.companyId);
    const out = await createProductFromLine(inv.id, item.id, ctx.companyId, { mode: "needed", name: item.data?.name, ...(a.values || {}) }, userIdOf(ctx));
    const product = out.product || out;
    return { productId: product.id, name: product.name, lineNo: item.lineNo, ref: product.id ? { type: "product", id: product.id, name: product.name } : null };
  },
});

defineTool({
  name: "confirm_invoice",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices"],
  label: "Confirming the invoice",
  description: "Proposes confirming an invoice under review (the invoice page's Confirm): every line must be matched to a product or ignored first. A confirmed invoice is ready for Generate. Shows a card first.",
  args: z.object({ invoiceId: id("invoice") }),
  preview: async (a, ctx) => {
    const inv = await loadInvoice(a.invoiceId, ctx.companyId);
    if (inv.status !== "review") throw new ToolError(`Invoice ${invoiceLabel(inv)} is ${inv.status}, not under review — nothing to confirm`, "not_in_review");
    const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id }, select: { matchStatus: true } });
    return {
      title: "Confirm invoice",
      summary: `Invoice ${invoiceLabel(inv)} is marked reviewed and ready for Generate.`,
      runLabel: "Confirm",
      details: [
        { label: "Invoice", value: `${invoiceLabel(inv)} · ${await companyName(ctx.companyId)}` },
        { label: "Lines", value: `${lines.filter((l) => l.matchStatus === "matched").length} matched · ${lines.filter((l) => l.matchStatus === "ignored").length} ignored` },
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const inv = await confirmInvoice(a.invoiceId, ctx.companyId, userIdOf(ctx));
    return { invoiceId: inv.id, status: inv.status, link: `/invoices/${inv.id}` };
  },
});

defineTool({
  name: "prepare_certificates",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices"],
  label: "Preparing certificates",
  description: "Proposes 'Prepare certificates' for an invoice: the background job that fills what it can of the missing certificate data (from products, catalogues and — where the company allows — AI). Shows a card first.",
  args: z.object({ invoiceId: id("invoice") }),
  preview: async (a, ctx) => {
    const inv = await loadInvoice(a.invoiceId, ctx.companyId);
    const lines = await prisma.invoiceItem.count({ where: { invoiceId: inv.id, matchStatus: "matched" } });
    return {
      title: "Prepare certificates",
      summary: `Fills what it can of the missing certificate data for the ${lines} matched line${lines === 1 ? "" : "s"} of invoice ${invoiceLabel(inv)}. Lab results and batch facts are never filled.`,
      runLabel: "Prepare",
      details: [
        { label: "Invoice", value: `${invoiceLabel(inv)} · ${await companyName(ctx.companyId)}` },
        { label: "Matched lines", value: String(lines) },
      ],
      aiCalls: "Looks up missing product facts · up to about 2 AI calls per product (your company's AI settings apply)",
      missing: ["Lab results and batch facts stay empty until you enter them or a supplier COA is read"],
    };
  },
  run: async (a, ctx) => {
    const out = await startPrepare(a.invoiceId, ctx.companyId, userIdOf(ctx));
    return { invoiceId: a.invoiceId, taskId: out.taskId, link: `/invoices/${a.invoiceId}` };
  },
});

defineTool({
  name: "generate_certificates",
  module: "certificates",
  risk: "write",
  permissions: ["create_certificates"],
  label: "Generating certificates",
  description:
    "Proposes generating certificate DRAFTS for an invoice's matched lines (the existing Generate; never final). certificateTypeIds: which types (omit to keep the invoice's choice). " +
    "The card shows how many certificates per type, the lines skipped and what is still missing (shown flagged on the drafts, never filled).",
  args: z.object({ invoiceId: id("invoice"), certificateTypeIds: z.array(z.string().uuid()).max(20).optional() }),
  preview: async (a, ctx) => {
    const inv = await loadInvoice(a.invoiceId, ctx.companyId);
    const plan = await planOf(a.certificateTypeIds ? { ...inv, certificateTypeIds: a.certificateTypeIds } : inv);
    if (!plan.entries.length) throw new ToolError(`No active template applies to any matched line of invoice ${invoiceLabel(inv)} — nothing to generate`, "nothing_to_generate");
    const perType = {};
    for (const e of plan.entries) perType[e.typeCode || e.typeName] = (perType[e.typeCode || e.typeName] || 0) + 1;
    const lines = [...new Set(plan.entries.flatMap((e) => e.lineNos))].sort((x, y) => x - y);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id }, select: { lineNo: true, matchStatus: true } });
    const skipped = items.filter((i) => !lines.includes(i.lineNo)).map((i) => `${i.lineNo}${i.matchStatus !== "matched" ? " (no product)" : " (no template)"}`);
    let missing = [];
    try {
      const needs = await getNeeds(inv.id, ctx.companyId);
      const lab = needs.certificates.flatMap((c) => c.needs.filter((n) => n.status === "missing" && (n.labResult || n.batchFact)));
      const other = needs.summary.missing - lab.filter((n) => n.required).length;
      if (lab.length) missing.push(`${[...new Set(lab.map((n) => n.label))].join(", ")} on ${lab.length} value${lab.length === 1 ? "" : "s"} — flagged, not filled`);
      if (other > 0) missing.push(`${other} other required value${other === 1 ? "" : "s"} missing — Generate may stop until they are filled (see the data check)`);
    } catch {
      missing = ["The data check hasn't run on this invoice yet"];
    }
    return {
      title: `Generate ${plan.entries.length} certificate${plan.entries.length === 1 ? "" : "s"}`,
      summary: `Drafts only — nothing is finalized. ${plan.entries.length} certificate${plan.entries.length === 1 ? "" : "s"} for invoice ${invoiceLabel(inv)}.`,
      runLabel: "Generate",
      details: [
        { label: "Invoice", value: `${invoiceLabel(inv)} · ${await companyName(ctx.companyId)}` },
        { label: "Lines", value: `${lines.join(", ")}${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}` },
        { label: "Types", value: `${Object.entries(perType).map(([t, n]) => `${t} × ${n}`).join(", ")} · drafts` },
      ],
      aiCalls: null,
      missing,
    };
  },
  run: async (a, ctx) => {
    if (a.certificateTypeIds) await updateInvoice(a.invoiceId, ctx.companyId, { certificateTypeIds: a.certificateTypeIds });
    const out = await startGeneration(a.invoiceId, ctx.companyId, userIdOf(ctx), { force: false, canForce: false });
    return { invoiceId: a.invoiceId, batchId: out.batchId, taskId: out.taskId, planned: out.planned, ...(await certificatesOfBatch(out.batchId)) };
  },
});

defineTool({
  name: "upload_supplier_coa",
  module: "invoices",
  risk: "write",
  permissions: ["update_invoices"],
  label: "Reading the supplier COA",
  description:
    "Proposes adding attached supplier COAs / lab reports to an invoice: each is read (1 AI call per file) and a result is kept only when its text is printed verbatim in the file and its batch number matches a line. " +
    "This is the only way the assistant may bring in lab results.",
  args: z.object({ invoiceId: id("invoice"), attachmentIds: z.array(attachmentArg).min(1).max(10) }),
  preview: async (a, ctx) => {
    const inv = await loadInvoice(a.invoiceId, ctx.companyId);
    const files = await Promise.all(a.attachmentIds.map((x) => loadAttachment(x, { conversationId: ctx.conversationId, companyId: ctx.companyId })));
    return {
      title: "Read supplier COA",
      summary: `The file${files.length === 1 ? " is" : "s are"} added to invoice ${invoiceLabel(inv)} and read; a result is kept only when it is printed in the file and its batch number matches a line.`,
      runLabel: "Read",
      details: [
        { label: "Invoice", value: `${invoiceLabel(inv)} · ${await companyName(ctx.companyId)}` },
        { label: files.length === 1 ? "File" : "Files", value: files.map(fileLine).join("; ") },
      ],
      aiCalls: `Reads ${files.length === 1 ? "the file" : "each file"} · ${files.length} AI call${files.length === 1 ? "" : "s"}`,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const files = await Promise.all(a.attachmentIds.map(async (x) => attachmentFile(await loadAttachment(x, { conversationId: ctx.conversationId, companyId: ctx.companyId }))));
    const out = await uploadCoas({ invoiceId: a.invoiceId, companyScope: ctx.companyId, files, userId: userIdOf(ctx) });
    return { invoiceId: a.invoiceId, taskId: out.taskId, coas: out.coas.map((c) => ({ id: c.id, fileName: c.fileName })), link: `/invoices/${a.invoiceId}` };
  },
});

// ── catalogues and labels ───────────────────────────────────────────────────
defineTool({
  name: "upload_catalogue",
  module: "catalogues",
  risk: "write",
  permissions: ["manage_catalogues"],
  label: "Uploading the catalogue",
  description:
    "Proposes uploading an attached catalogue PDF as a new edition (edition: e.g. \"2026\"). It stops at Choose pages: the person picks the product pages there — nothing is read by AI before that.",
  args: z.object({ attachmentId: attachmentArg, edition: z.string().min(1).max(60), manufacturer: z.string().max(120).optional(), brandId: z.string().uuid().optional() }),
  preview: async (a, ctx) => {
    const att = await attachment(a, ctx);
    if (att.mimeType !== "application/pdf") throw new ToolError("A catalogue must be a PDF", "not_pdf");
    const brand = a.brandId ? await prisma.brand.findFirst({ where: { id: a.brandId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.brandId && !brand) throw new ToolError("Brand not found!", "not_found");
    return {
      title: "Upload catalogue",
      summary: "The catalogue is stored as a new edition. Next you choose its product pages — only those are read.",
      runLabel: "Upload",
      details: [
        { label: "File", value: fileLine(att) },
        { label: "Company", value: await companyName(ctx.companyId) },
        { label: "Edition", value: a.edition },
        ...(a.manufacturer || brand ? [{ label: "Catalogue", value: a.manufacturer || brand.name }] : []),
      ],
      aiCalls: "None now — after you choose the pages",
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await attachment(a, ctx);
    const out = await uploadCatalogue({ companyId: ctx.companyId, manufacturer: a.manufacturer || null, brandId: a.brandId || null, label: a.edition, file: await attachmentFile(att), userId: userIdOf(ctx) });
    return { catalogueId: out.catalogue.id, versionId: out.version.id, pages: out.pageCount, link: `/catalogues/versions/${out.version.id}/pages`, next: "Choose the product pages on the linked screen." };
  },
});

defineTool({
  name: "verify_label",
  module: "labels",
  risk: "write",
  permissions: ["read_products"],
  label: "Checking the label",
  description: "Proposes checking an attached label (PDF or image) against a country's rules, in the background (about 2 AI calls).",
  args: z.object({ attachmentId: attachmentArg, country: z.string().min(2).max(60) }),
  preview: async (a, ctx) => {
    const att = await attachment(a, ctx);
    return {
      title: "Check label",
      summary: `The label is checked against ${a.country}'s rules in the background.`,
      runLabel: "Check",
      details: [{ label: "File", value: fileLine(att) }, { label: "Company", value: await companyName(ctx.companyId) }, { label: "Country", value: a.country }],
      aiCalls: "Reads and checks the label · about 2 AI calls",
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await attachment(a, ctx);
    const f = await attachmentFile(att);
    return { taskId: (await startLabelVerification({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype, country: a.country, companyId: ctx.companyId })).taskId };
  },
});

defineTool({
  name: "upload_label",
  module: "labels",
  risk: "write",
  permissions: ["update_labels"],
  label: "Adding the reference label",
  description: "Proposes adding an attached approved label as a reference label of the current company (read in the background, about 1 AI call). Use this when the user uploads or sends a label to keep, store or use as a reference — never upload_label_and_resize unless they ask to change its size.",
  args: z.object({ attachmentId: attachmentArg, country: z.string().min(2).max(60), brandId: z.string().uuid().optional() }),
  preview: async (a, ctx) => {
    const att = await attachment(a, ctx);
    return {
      title: "Add reference label",
      summary: "The label is read in the background and kept as one of your company's reference labels.",
      runLabel: "Add",
      details: [{ label: "File", value: fileLine(att) }, { label: "Company", value: await companyName(ctx.companyId) }, { label: "Country", value: a.country }],
      aiCalls: "Reads the label · about 1 AI call",
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await attachment(a, ctx);
    const f = await attachmentFile(att);
    const out = await queueReferenceLabel({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype, country: a.country, companyId: ctx.companyId, brandId: a.brandId || null });
    if (out.skipped) throw new ToolError(`${f.originalname}: the same file was already uploaded as a reference on ${uploadedOn(out.existing.createdAt)} (${out.existing.name})`, "exists");
    return { taskId: out.taskId };
  },
});

// ── products ────────────────────────────────────────────────────────────────
const PRODUCT_TEXT_FIELDS = NEW_PRODUCT_FIELDS;
const fieldKey = z.union([z.enum(PRODUCT_TEXT_FIELDS), z.string().regex(/^specifications\.[^.]{1,60}$/)]);

defineTool({
  name: "update_product_fields",
  module: "products",
  risk: "write",
  permissions: ["update_products"],
  label: "Updating the product",
  description:
    `Proposes changing product fields: changes [{ field, value }], field one of ${PRODUCT_TEXT_FIELDS.join(", ")} or "specifications.<name>" (e.g. specifications.pH). ` +
    "The card shows old → new. Never lab results or batch facts (batch/lot, dates): those come from the lab, the batch or a supplier COA.",
  args: z.object({ productId: id("product"), changes: z.array(z.object({ field: fieldKey, value: z.string().max(4000) })).min(1).max(20) }),
  guard: (a, ctx) => a.changes.forEach((c) => assertVerbatim(c.field, c.value, ctx)),
  preview: async (a, ctx) => {
    const p = await prisma.product.findFirst({ where: { id: a.productId, companyId: ctx.companyId } });
    if (!p) throw new ToolError("Product not found!", "not_found");
    const specs = (p.specifications && typeof p.specifications === "object" ? p.specifications.values || {} : {}) || {};
    const old = (f) => (f.startsWith("specifications.") ? specs[f.slice(15)] : p[f]) ?? "—";
    return {
      title: `Update ${p.name}`,
      summary: `${a.changes.length} field${a.changes.length === 1 ? "" : "s"} of ${p.name} will change.`,
      runLabel: "Save",
      details: a.changes.map((c) => ({ label: c.field, value: `${old(c.field)} → ${c.value}` })),
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const p = await prisma.product.findFirst({ where: { id: a.productId, companyId: ctx.companyId } });
    if (!p) throw new ToolError("Product not found!", "not_found");
    const data = {};
    const specChanges = {};
    for (const c of a.changes) {
      if (c.field.startsWith("specifications.")) specChanges[c.field.slice(15)] = c.value;
      else data[c.field] = c.value;
    }
    if (Object.keys(specChanges).length) {
      const base = p.specifications && typeof p.specifications === "object" ? p.specifications : { type: "string", values: {} };
      data.specifications = { ...base, values: { ...(base.values || {}), ...specChanges } };
    }
    const updated = await updateProduct(p.id, data, ctx.companyId);
    return { productId: updated.id, name: updated.name, changed: a.changes.map((c) => c.field), ref: { type: "product", id: updated.id, name: updated.name } };
  },
});

// The products API's own validator (POST /products), without companyId (the registry adds it) and
// without specifications (a free-form record; set those afterwards with update_product_fields).
export const CREATE_PRODUCT_ARGS = createProductSchema.body.omit({ companyId: true, specifications: true });

defineTool({
  name: "create_product",
  module: "products",
  risk: "write",
  permissions: ["create_products"],
  label: "Adding the product",
  description:
    "Proposes adding a product to the company (the Products page's Add): name, brand (list_brands), category (list_categories), composition (activeIngredients: [{ name, concentration }]) and any other product field the user gave. " +
    "Values come from the user's own words; ids from lookups. Shows a card first.",
  args: CREATE_PRODUCT_ARGS,
  guard: (a, ctx) => Object.entries(a).forEach(([k, v]) => typeof v === "string" && assertVerbatim(k, v, ctx)),
  preview: async (a, ctx) => {
    const brand = a.brandId ? await prisma.brand.findFirst({ where: { id: a.brandId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.brandId && !brand) throw new ToolError("Brand not found!", "not_found");
    const category = a.categoryId ? await prisma.category.findUnique({ where: { id: a.categoryId }, select: { name: true } }) : null;
    if (a.categoryId && !category) throw new ToolError("Category not found!", "not_found");
    const same = await prisma.product.findFirst({ where: { companyId: ctx.companyId, name: { equals: a.name, mode: "insensitive" } }, select: { id: true } });
    const text = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? [x.name, x.concentration].filter(Boolean).join(" ") : x)).join(", ") : String(v));
    return {
      title: `Add ${a.name}`,
      summary: `A new product ${a.name} is added to ${await companyName(ctx.companyId)}.`,
      runLabel: "Add",
      details: [
        { label: "Company", value: await companyName(ctx.companyId) },
        { label: "Name", value: a.name },
        ...(brand ? [{ label: "Brand", value: brand.name }] : []),
        ...(category ? [{ label: "Category", value: category.name }] : []),
        ...Object.entries(a).filter(([k, v]) => !["name", "brandId", "categoryId"].includes(k) && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => ({ label: k, value: text(v) })),
      ],
      aiCalls: null,
      missing: same ? [`A product named ${a.name} already exists in this company`] : [],
    };
  },
  run: async (a, ctx) => {
    const product = await createProduct(ctx.companyId, a);
    return { productId: product.id, name: product.name, ref: { type: "product", id: product.id, name: product.name } };
  },
});
