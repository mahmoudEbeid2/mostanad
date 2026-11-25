import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { loadAttachment, attachmentFile } from "../../attachments.js";
import { uniqueUsername } from "../../../intake/intakeService.js";
import { createProduct } from "../../../productService.js";
import { createCategory } from "../../../categoryService.js";
import { createType } from "../../../certificates/types/certificateTypeService.js";
import { KNOWN_TYPES } from "../../../certificates/templates/fromFiles.js";
import { queueReferenceLabel, uploadedOn } from "../../../label/labelUploads.js";
import { queueRegulatoryDocument } from "../../../label/regulatory/regulatoryUploads.js";
import { generateForProducts, BATCH_FACTS } from "../../../certificates/direct/directService.js";
import { countryCode, countryLabel } from "../../countries.js";
import { assertVerbatim } from "./actions.js";
import { id } from "./common.js";

// Registering from the chat (client, 25 Nov: "afterwards I add the company, the labels and
// everything through the chatbot"). Every one is a confirmation card; nothing happens until
// the person presses its button. A company is created only by a system user; a company
// user works inside its own company. Approving rules, finalizing certificates, deleting,
// users and roles stay out of the chat (their pages do them).

const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const companyName = async (cid) => (await prisma.company.findUnique({ where: { id: cid }, select: { name: true } }))?.name || cid;
const attachmentArg = z.string().uuid().describe("The id of a file attached in this conversation (shown in the user's message as [attached: …])");
const load = (x, ctx) => loadAttachment(x, { conversationId: ctx.conversationId, companyId: ctx.companyId });
const norm = (s) => String(s || "").trim().toLowerCase();

defineTool({
  name: "create_company",
  module: "companies",
  risk: "write",
  systemOnly: true,
  createsCompany: true,
  permissions: ["create_companies"],
  label: "Adding the company",
  description:
    "SYSTEM USERS ONLY. Proposes adding a NEW company (a confirmation card) — when the user wants a company that list_companies doesn't have (\"ضيف شركة MAXVET\"). " +
    "Look it up first (list_companies); a close existing name is shown on the card. Its login is set later on the Companies page (reset password). " +
    "For files of a company that doesn't exist yet, start_intake creates it with the files instead.",
  args: z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(160).optional() }),
  preview: async (a) => {
    const all = await prisma.company.findMany({ where: { name: { contains: a.name.slice(0, 4), mode: "insensitive" } }, select: { name: true }, take: 10 });
    if (all.some((c) => norm(c.name) === norm(a.name))) throw new ToolError(`A company named ${a.name} already exists`, "exists");
    return {
      title: `Add company ${a.name}`,
      summary: `A new company "${a.name}". Its brands, products, labels and certificate templates can then be added. Its login is set on the Companies page.`,
      runLabel: "Add company",
      details: [{ label: "Company", value: a.name }, ...(a.email ? [{ label: "Email", value: a.email }] : []), ...(all.length ? [{ label: "Similar companies already there", value: all.map((c) => c.name).join(", ") }] : [])],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a) => {
    if (a.email && (await prisma.company.findUnique({ where: { email: a.email }, select: { id: true } }))) throw new ToolError("That email is already used by another company", "exists");
    const c = await prisma.company.create({ data: { name: a.name, email: a.email || null, username: await uniqueUsername(a.name), password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12) }, select: { id: true, name: true } });
    return { companyId: c.id, name: c.name, link: "/companies", ref: { type: "company", id: c.id, name: c.name }, note: "Created. Further actions for it take companyId." };
  },
});

defineTool({
  name: "create_category",
  module: "categories",
  risk: "write",
  permissions: ["create_categories"],
  label: "Adding the category",
  description: "Proposes adding a product category (shared by all companies; a confirmation card) — after list_categories found no such name.",
  args: z.object({ name: z.string().trim().min(2).max(80) }),
  preview: async (a) => {
    const all = await prisma.category.findMany({ where: { name: { contains: a.name.slice(0, 4), mode: "insensitive" } }, select: { name: true }, take: 10 });
    if (all.some((c) => norm(c.name) === norm(a.name))) throw new ToolError(`The category ${a.name} already exists`, "exists");
    return { title: `Add category ${a.name}`, summary: `A new product category "${a.name}".`, runLabel: "Add category", details: [{ label: "Category", value: a.name }, ...(all.length ? [{ label: "Similar categories", value: all.map((c) => c.name).join(", ") }] : [])], aiCalls: null, missing: [] };
  },
  run: async (a) => {
    const c = await createCategory({ name: a.name });
    return { categoryId: c.id, name: c.name, link: "/categories" };
  },
});

const productRow = z.object({
  name: z.string().trim().min(1).max(160),
  packaging: z.string().trim().max(120).optional(),
  productCode: z.string().trim().max(60).optional(),
  dosageForm: z.string().trim().max(80).optional(),
});

defineTool({
  name: "create_products",
  module: "products",
  risk: "write",
  permissions: ["create_products"],
  label: "Adding the products",
  description:
    "Proposes adding SEVERAL products to the current company in one card (names, and pack / code / form only as the user gave them — never invented). " +
    "Products that already exist (same name) are shown and skipped. For many products from FILES (labels, sheets), use start_intake instead; for invoice lines, create_products_from_lines.",
  args: z.object({ products: z.array(productRow).min(1).max(50), brandId: z.string().uuid().optional() }),
  preview: async (a, ctx) => {
    const names = a.products.map((p) => p.name);
    const existing = await prisma.product.findMany({ where: { companyId: ctx.companyId, OR: names.map((n) => ({ name: { equals: n, mode: "insensitive" } })) }, select: { name: true } });
    const brand = a.brandId ? await prisma.brand.findFirst({ where: { id: a.brandId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.brandId && !brand) throw new ToolError("Brand not found in this company", "not_found");
    const fresh = a.products.filter((p) => !existing.some((e) => norm(e.name) === norm(p.name)));
    if (!fresh.length) throw new ToolError("All of these products already exist in this company", "exists");
    return {
      title: `Add ${fresh.length} product${fresh.length === 1 ? "" : "s"}`,
      summary: `${fresh.length} new product${fresh.length === 1 ? "" : "s"} for ${await companyName(ctx.companyId)}${brand ? ` under ${brand.name}` : ""}.`,
      runLabel: `Add ${fresh.length}`,
      details: [
        ...fresh.map((p) => ({ label: p.name, value: [p.packaging, p.productCode, p.dosageForm].filter(Boolean).join(" · ") || "name only" })),
        ...(existing.length ? [{ label: "Already there (skipped)", value: existing.map((e) => e.name).join(", ") }] : []),
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const made = [];
    for (const p of a.products) {
      if (await prisma.product.findFirst({ where: { companyId: ctx.companyId, name: { equals: p.name, mode: "insensitive" } }, select: { id: true } })) continue;
      const row = await createProduct(ctx.companyId, { name: p.name, ...(p.packaging ? { packaging: p.packaging } : {}), ...(p.productCode ? { productCode: p.productCode } : {}), ...(p.dosageForm ? { dosageForm: p.dosageForm } : {}), ...(a.brandId ? { brandId: a.brandId } : {}), fieldProvenance: { name: { source: "assistant", by: userIdOf(ctx) } } });
      made.push({ id: row.id, name: row.name });
    }
    return { products: made, link: "/products", note: `${made.length} added.` };
  },
});

defineTool({
  name: "add_reference_labels",
  module: "labels",
  risk: "write",
  permissions: ["update_labels"],
  label: "Adding the reference labels",
  description:
    "Proposes adding SEVERAL attached approved labels as reference labels of the current company in one card (each read in the background, about 1 AI call each), for one country (ask it if the user didn't say). " +
    "A file the company already has (the same file) is shown and skipped. Only when the user wants to keep / use them as references — not to resize them.",
  args: z.object({ attachmentIds: z.array(attachmentArg).min(1).max(30), country: z.string().min(2).max(60), brandId: z.string().uuid().optional() }),
  preview: async (a, ctx) => {
    const atts = await Promise.all(a.attachmentIds.map((x) => load(x, ctx)));
    const bad = atts.filter((x) => !["application/pdf", "image/png", "image/jpeg"].includes(x.mimeType));
    if (bad.length) throw new ToolError(`${bad.map((x) => x.name).join(", ")}: a reference label must be a PDF, PNG or JPEG`, "bad_type");
    const code = countryCode(a.country);
    return {
      title: `Add ${atts.length} reference label${atts.length === 1 ? "" : "s"}`,
      summary: `Each label is read in the background and kept as a reference of ${await companyName(ctx.companyId)} for ${code ? countryLabel(code) : a.country}.`,
      runLabel: `Add ${atts.length}`,
      details: [{ label: "Files", value: atts.map((x) => x.name).join(", ") }, { label: "Country", value: code ? countryLabel(code) : a.country }],
      aiCalls: `about ${atts.length} AI call${atts.length === 1 ? "" : "s"}`,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const out = [];
    for (const x of a.attachmentIds) {
      const att = await load(x, ctx);
      const f = await attachmentFile(att);
      const q = await queueReferenceLabel({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype, country: countryCode(a.country) || a.country, companyId: ctx.companyId, brandId: a.brandId || null });
      out.push(q.skipped ? { file: att.name, skipped: `the same file was already added on ${uploadedOn(q.existing.createdAt)}` } : { file: att.name, taskId: q.taskId });
    }
    return { labels: out, taskId: out.find((o) => o.taskId)?.taskId, link: "/reference-labels" };
  },
});

defineTool({
  name: "create_certificate_type",
  module: "certificates",
  risk: "write",
  permissions: ["create_certificate_types"],
  label: "Adding the certificate type",
  description:
    "Proposes adding a certificate type to the current company (code + name; a confirmation card) — after list_certificate_types found none with that code. " +
    "COC is the Certificate of Composition, COO the Certificate of Origin — two different types.",
  args: z.object({ code: z.string().trim().min(2).max(8), name: z.string().trim().min(3).max(80).optional() }),
  preview: async (a, ctx) => {
    const code = a.code.toUpperCase();
    if (await prisma.certificateType.findFirst({ where: { companyId: ctx.companyId, code }, select: { id: true } })) throw new ToolError(`This company already has the certificate type ${code}`, "exists");
    const name = a.name || KNOWN_TYPES[code]?.name;
    if (!name) throw new ToolError(`What is ${code} called in full? (e.g. "Certificate of Analysis")`, "needs_name");
    return { title: `Add certificate type ${code}`, summary: `${code} — ${name}, for ${await companyName(ctx.companyId)}.`, runLabel: "Add type", details: [{ label: "Code", value: code }, { label: "Name", value: name }], aiCalls: null, missing: [] };
  },
  run: async (a, ctx) => {
    const code = a.code.toUpperCase();
    const t = await createType(ctx.companyId, { code, name: a.name || KNOWN_TYPES[code]?.name || code });
    return { certificateTypeId: t.id, code: t.code, name: t.name, link: "/certificates/types" };
  },
});

defineTool({
  name: "add_regulatory_rules",
  module: "regulatory",
  risk: "write",
  permissions: ["create_regulatory"],
  label: "Reading the regulation",
  description:
    "Proposes reading an attached REGULATION document (PDF) for a country so its labelling rules can be used in label checks (a confirmation card, a few AI calls). " +
    "The rules are read and shown for approval — they are NOT used until a person approves them on the label page (\"Add rules for <country>\") or the Regulatory page. You can't approve them in the chat; say where.",
  args: z.object({ attachmentId: attachmentArg, country: z.string().min(2).max(60), title: z.string().max(160).optional() }),
  preview: async (a, ctx) => {
    const att = await load(a.attachmentId, ctx);
    if (att.mimeType !== "application/pdf") throw new ToolError(`${att.name} is not a PDF — the regulation must be a PDF`, "bad_type");
    const code = countryCode(a.country);
    if (!code) throw new ToolError(`Which country is "${a.country}"? Name it (e.g. Saudi Arabia, Egypt, Malaysia).`, "country");
    return {
      title: `Read ${countryLabel(code)}'s rules`,
      summary: `${att.name} is read and its labelling rules are proposed. They apply to label checks only after a person approves them.`,
      runLabel: "Read the rules",
      details: [{ label: "File", value: att.name }, { label: "Country", value: countryLabel(code) }, { label: "Then", value: "approve them on the label page or the Regulatory page" }],
      aiCalls: "about 3 AI calls (read, rules, coverage)",
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await load(a.attachmentId, ctx);
    const f = await attachmentFile(att);
    const out = await queueRegulatoryDocument({ buffer: f.buffer, fileName: att.name, mimeType: "application/pdf", country: countryCode(a.country), companyId: ctx.companyId, title: a.title || null, review: true });
    return { taskId: out.taskId, link: "/regulatory-documents", note: "Being read. When it finishes, the rules wait for a person's approval (label page → Add rules, or the Regulatory page). Never say they are in force." };
  },
});

defineTool({
  name: "generate_certificates_for_products",
  module: "certificates",
  risk: "write",
  permissions: ["create_certificates"],
  label: "Making the certificates",
  description:
    "Proposes certificate DRAFTS for SEVERAL products at once, with NO invoice (\"طلّعلي COA وFSC للمنتجات دي\"). productIds (search_products), certificateTypeIds (list_certificate_types). " +
    "One run: a per-product template makes one certificate per product; a per-invoice template one certificate listing them all. The card shows what will be made and which product has no template. " +
    "Batch facts (batches: batchNo, productionDate, expiryDate per product) only as the user typed them — never invented; missing ones stay flagged blanks on the drafts. Drafts are never final in the chat.",
  args: z.object({
    productIds: z.array(z.string().uuid()).min(1).max(50),
    certificateTypeIds: z.array(z.string().uuid()).min(1).max(10),
    batches: z.array(z.object({ productId: z.string().uuid(), batchNo: z.string().max(80).optional(), productionDate: z.string().max(40).optional(), expiryDate: z.string().max(40).optional() })).max(50).optional(),
    country: z.string().max(60).optional(),
  }),
  preview: async (a, ctx) => {
    for (const b of a.batches || []) for (const k of ["batchNo", "productionDate", "expiryDate"]) if (b[k]) assertVerbatim(k, b[k], ctx);
    const products = a.productIds.map((productId) => ({ productId, batch: (a.batches || []).find((b) => b.productId === productId) || {} }));
    let plan;
    try {
      plan = await generateForProducts({ companyId: ctx.companyId, products, certificateTypeIds: a.certificateTypeIds, country: a.country || null, dryRun: true });
    } catch (err) {
      throw new ToolError(err.message, err.code === "NOT_FOUND" ? "not_found" : "invalid");
    }
    if (!plan.planned.length) throw new ToolError(`No active template applies: ${plan.missing.map((m) => `${m.type} for ${m.product}`).join(", ")}. Make templates first (create_certificate_templates), mark their fields and activate them.`, "no_template");
    const given = (a.batches || []).flatMap((b) => BATCH_FACTS.filter((k) => b[k]).map((k) => `${k} ${b[k]}`));
    return {
      title: `${plan.planned.length} certificate draft${plan.planned.length === 1 ? "" : "s"}`,
      summary: `Drafts for ${a.productIds.length} product${a.productIds.length === 1 ? "" : "s"} without an invoice — never final until a person approves each one.`,
      runLabel: "Make the drafts",
      details: [
        { label: "Company", value: await companyName(ctx.companyId) },
        ...plan.planned.map((e, i) => ({ label: i ? "" : "Will be made", value: `${e.type} — ${e.products.join(", ")}` })),
        ...(plan.missing.length ? [{ label: "No template (not made)", value: plan.missing.map((m) => `${m.type} for ${m.product}`).join(", ") }] : []),
        ...(given.length ? [{ label: "Batch facts (as you typed)", value: given.join("; ") }] : []),
        { label: "Invoice", value: "none" },
      ],
      aiCalls: null,
      missing: given.length ? [] : ["batch number, production and expiry dates not given — empty and flagged on the drafts"],
    };
  },
  run: async (a, ctx) => {
    const products = a.productIds.map((productId) => {
      const b = (a.batches || []).find((x) => x.productId === productId) || {};
      return { productId, batch: { batchNo: b.batchNo, productionDate: b.productionDate, expiryDate: b.expiryDate } };
    });
    const out = await generateForProducts({ companyId: ctx.companyId, userId: userIdOf(ctx), products, certificateTypeIds: a.certificateTypeIds, country: a.country || null });
    return { invoiceId: out.invoiceId, batchId: out.batchId, taskId: out.taskId, planned: out.planned, missing: out.missing, link: `/certificates?invoiceId=${out.invoiceId}`, note: "Drafts being made. Tell the user they open from the link; each is approved on its page." };
  },
});
