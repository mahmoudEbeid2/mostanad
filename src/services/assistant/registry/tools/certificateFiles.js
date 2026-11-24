import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { loadAttachment, attachmentFile } from "../../attachments.js";
import { planTemplatesFromFiles, createTemplatesFromFiles } from "../../../certificates/templates/fromFiles.js";
import { planDirect, createDirectRequest, generateForProduct, BATCH_FACTS } from "../../../certificates/direct/directService.js";
import { uploadCoas } from "../../../certificates/labResults/coaService.js";
import { assertVerbatim } from "./actions.js";
import { id } from "./common.js";

// Client report 24 Nov ("maxvet label"): four certificate files of the brand
// were attached and the assistant asked for an invoice number four times. A
// brand's certificate files become its templates here, and a certificate can be
// made for a product without an invoice. Both are confirmation cards.

const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const companyName = async (id) => (await prisma.company.findUnique({ where: { id }, select: { name: true } }))?.name || id;
const attachmentArg = z.string().uuid().describe("The id of a file attached in this conversation (shown in the user's message as [attached: …])");
const load = (x, ctx) => loadAttachment(x, { conversationId: ctx.conversationId, companyId: ctx.companyId });

defineTool({
  name: "create_certificate_templates",
  module: "certificates",
  risk: "write",
  permissions: ["create_certificate_templates", "create_certificate_types"],
  label: "Making certificate templates",
  description:
    "Proposes turning attached certificate FILES of the company (its own FSC, COO/COC, HC, COA… — not an invoice, not a supplier COA to read results from) into certificate templates, several files in one card. " +
    "Each file → its certificate type (read from the file name, or `codes` per file when the name doesn't say; the type is created for the company when missing) → converted in the background into a DRAFT template " +
    "(or a new draft version when that type already has a template for this brand / country). The person then marks the fields and activates it on the template screen (link in the result). " +
    "brandId: the brand these certificates are for (list_brands). Use this when the user sends their certificates and says they are the brand's / company's certificates or templates. No invoice is needed.",
  args: z.object({
    attachmentIds: z.array(attachmentArg).min(1).max(10),
    codes: z.array(z.object({ attachmentId: attachmentArg, code: z.string().min(2).max(10) })).max(10).optional().describe("The certificate type code of a file whose name doesn't say it (e.g. COA)"),
    brandId: z.string().uuid().optional(),
    country: z.string().length(2).optional().describe("Only when these certificates are for one destination country (ISO alpha-2)"),
  }),
  preview: async (a, ctx) => {
    const files = await Promise.all(a.attachmentIds.map((x) => load(x, ctx)));
    const codeOf = (fid) => a.codes?.find((c) => c.attachmentId === fid)?.code || null;
    const brand = a.brandId ? await prisma.brand.findFirst({ where: { id: a.brandId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.brandId && !brand) throw new ToolError("Brand not found!", "not_found");
    const plan = await planTemplatesFromFiles(ctx.companyId, files.map((f) => ({ name: f.name, code: codeOf(f.id) })), { brandId: a.brandId || null, country: a.country?.toUpperCase() || null });
    const bad = plan.filter((p) => p.problem);
    if (bad.length) throw new ToolError(bad.map((p) => `${p.name}: ${p.problem}`).join("; "), "needs_type");
    return {
      title: `Make ${plan.length} certificate template${plan.length === 1 ? "" : "s"}`,
      summary: `Each file becomes a draft template${brand ? ` for ${brand.name}` : ""}. Nothing is activated: you mark the fields and activate each one on its template screen.`,
      runLabel: "Make templates",
      details: [
        { label: "Company", value: await companyName(ctx.companyId) },
        ...(brand ? [{ label: "Brand", value: brand.name }] : []),
        ...(a.country ? [{ label: "Country", value: a.country.toUpperCase() }] : []),
        ...plan.map((p) => ({ label: p.name, value: `${p.code}${p.createType ? " (new certificate type)" : ""} · ${p.slot === "new_version" ? `new draft version of "${p.templateName}"` : "new draft template"}` })),
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const atts = await Promise.all(a.attachmentIds.map((x) => load(x, ctx)));
    const files = await Promise.all(atts.map(async (att) => ({ file: await attachmentFile(att), code: a.codes?.find((c) => c.attachmentId === att.id)?.code || null })));
    const results = await createTemplatesFromFiles({ companyId: ctx.companyId, userId: userIdOf(ctx), files, brandId: a.brandId || null, country: a.country?.toUpperCase() || null });
    return {
      templates: results.map((r) => ({ file: r.name, type: r.code, typeCreated: r.typeCreated, newVersion: r.newVersion, templateId: r.templateId, versionId: r.versionId, taskId: r.taskId, link: r.link })),
      taskId: results[0]?.taskId,
      link: results.length === 1 ? results[0].link : "/certificates/templates",
      note: "Each file is being converted. Tell the user to open each template's link to mark its fields and activate it; then certificates can be made from it (generate_certificate_for_product, or an invoice).",
    };
  },
});

const batchArgs = {
  batchNo: z.string().max(80).optional(),
  productionDate: z.string().max(40).optional(),
  expiryDate: z.string().max(40).optional(),
  quantity: z.string().max(40).optional(),
  unit: z.string().max(20).optional(),
  packing: z.string().max(80).optional(),
};

defineTool({
  name: "generate_certificate_for_product",
  module: "certificates",
  risk: "write",
  permissions: ["create_certificates"],
  label: "Making the certificate",
  description:
    "Proposes a certificate DRAFT for one product WITHOUT an invoice — use it when the user wants a certificate for a product and there is no invoice (\"don't use a number\"). Never ask for an invoice number or id for this. " +
    "productId (search_products), certificateTypeId (list_certificate_types). Batch facts (batchNo, productionDate, expiryDate, quantity, unit, packing) only as the user typed them — never invented; " +
    "what isn't given stays empty and is flagged on the draft. coaAttachmentIds: a supplier COA / lab report to read the lab results from — then batchNo is required (the COA's results attach to that batch) " +
    "and the draft is made after the COA is read (call generate_certificates with the invoiceId this returns). Same engine, versions and PDF as invoice certificates.",
  args: z.object({ productId: id("product"), certificateTypeId: id("certificate type"), country: z.string().length(2).optional(), coaAttachmentIds: z.array(attachmentArg).max(5).optional(), ...batchArgs }),
  preview: async (a, ctx) => {
    // batch facts only as the person typed them (checked when the card is made, against their messages)
    for (const k of BATCH_FACTS) if (a[k]) assertVerbatim(k, a[k], ctx);
    const plan = await planDirect(ctx.companyId, { productId: a.productId, certificateTypeId: a.certificateTypeId, country: a.country || null });
    if (!plan.entries.length) throw new ToolError(`There is no active ${plan.type.code} template for ${plan.product.name}${plan.product.brand ? ` (${plan.product.brand.name})` : ""}. Make one first: attach the certificate file and use create_certificate_templates, then mark its fields and activate it.`, "no_template");
    if (a.coaAttachmentIds?.length && !a.batchNo) throw new ToolError("To read a supplier COA onto this certificate I need the batch number — ask the user for the batch / lot number printed on it.", "needs_batch");
    const coas = a.coaAttachmentIds?.length ? await Promise.all(a.coaAttachmentIds.map((x) => load(x, ctx))) : [];
    const given = BATCH_FACTS.filter((k) => a[k]);
    const empty = BATCH_FACTS.filter((k) => !a[k] && ["batchNo", "productionDate", "expiryDate"].includes(k));
    return {
      title: `${plan.type.code} for ${plan.product.name}`,
      summary: coas.length ? `A draft ${plan.type.code} without an invoice. The supplier COA is read first; then the draft is made.` : `A draft ${plan.type.code} without an invoice — never final until you finalize it.`,
      runLabel: coas.length ? "Read the COA" : "Make the draft",
      details: [
        { label: "Company", value: await companyName(ctx.companyId) },
        { label: "Product", value: `${plan.product.name}${plan.product.productCode ? ` (${plan.product.productCode})` : ""}` },
        { label: "Certificate", value: `${plan.type.code} · template "${plan.template?.name || "—"}"` },
        { label: "Invoice", value: "none" },
        ...given.map((k) => ({ label: k, value: a[k] })),
        ...(coas.length ? [{ label: "Supplier COA", value: coas.map((c) => c.name).join(", ") }] : []),
      ],
      aiCalls: coas.length ? `Reads the COA · ${coas.length} AI call${coas.length === 1 ? "" : "s"}` : null,
      missing: empty.length && !coas.length ? [`${empty.join(", ")} not given — empty and flagged on the draft`] : [],
    };
  },
  run: async (a, ctx) => {
    const batch = Object.fromEntries(BATCH_FACTS.map((k) => [k, a[k] || null]));
    const base = { companyId: ctx.companyId, userId: userIdOf(ctx), productId: a.productId, certificateTypeId: a.certificateTypeId, batch, country: a.country || null };
    if (a.coaAttachmentIds?.length) {
      const { invoiceId } = await createDirectRequest(base);
      const files = await Promise.all(a.coaAttachmentIds.map(async (x) => attachmentFile(await load(x, ctx))));
      const out = await uploadCoas({ invoiceId, companyScope: ctx.companyId, files, userId: userIdOf(ctx) });
      return { invoiceId, taskId: out.taskId, note: "The COA is being read. When it is done, propose generate_certificates with this invoiceId (it is the product's certificate request, not a real invoice — call it that to the user)." };
    }
    const out = await generateForProduct(base);
    return { invoiceId: out.invoiceId, batchId: out.batchId, taskId: out.taskId, planned: out.planned, link: `/certificates?invoiceId=${out.invoiceId}` };
  },
});
