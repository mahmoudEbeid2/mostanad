import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { id } from "./common.js";
import { copyProduct, copyProductsBulk, diffFromSource, updateFromSource, resolveFields, COPY_FIELD_GROUPS, COPYABLE_FIELDS } from "../../../productCopyService.js";

// "Copy to another brand" from the chat. Three writes, each behind a confirmation
// card (the model only proposes; run() happens after the person presses Run),
// plus a read so the assistant can show what "update from source" would change.
// The card always says the registration number is NOT copied.
// Company: the card's company is the TARGET company (where the copy is made). A
// company session copies only within its own company (its products, its brands);
// a system user may copy a product of any company to this company's brand.

const GROUP_KEYS = COPY_FIELD_GROUPS.map((g) => g.key);
const groupsArg = z
  .array(z.enum(GROUP_KEYS))
  .max(GROUP_KEYS.length)
  .optional()
  .describe(`Field groups to copy (default: all): ${COPY_FIELD_GROUPS.map((g) => `${g.key} = ${g.label}`).join("; ")}. The registration number is never copied.`);
const keepLinkedArg = z.boolean().optional().describe("Keep the copy linked to the original (default true): its page shows the original and offers 'update from source'.");
const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const actorOf = (ctx) => ({ scopeCompanyId: ctx.isSystem ? null : ctx.companyId, userId: userIdOf(ctx) });
const groupsLine = (groups) => (groups?.length ? COPY_FIELD_GROUPS.filter((g) => groups.includes(g.key)).map((g) => g.label).join(", ") : "All product data");

/** The source product as this caller may read it (company session: own company only). */
async function sourceOf(productId, ctx) {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true, productCode: true, companyId: true, registrationNumber: true, brand: { select: { name: true } }, company: { select: { name: true } } } });
  if (!p || (!ctx.isSystem && p.companyId !== ctx.companyId)) throw new ToolError("Product not found!", "not_found");
  return p;
}
async function targetBrandOf(brandId, ctx) {
  const b = await prisma.brand.findFirst({ where: { id: brandId, companyId: ctx.companyId }, select: { id: true, name: true, company: { select: { name: true } } } });
  if (!b) throw new ToolError("Brand not found in this company", "not_found");
  return b;
}
const label = (p) => `${p.name}${p.productCode ? ` · ${p.productCode}` : ""}${p.brand?.name ? ` (${p.brand.name})` : ""}`;

defineTool({
  name: "copy_product_to_brand",
  module: "products",
  risk: "write",
  permissions: ["create_products"],
  label: "Copying the product",
  description:
    "Proposes copying a product to another brand under a new name: same composition and the rest of the product data (indications, dosage, species, storage, packaging, withdrawal, contraindications, user safety, specifications…). " +
    "Use it when the user says brand B sells brand A's product under another name. sourceProductId from search_products; targetBrandId from list_brands; name = the new product's name (from the user). " +
    "Never copied: the registration number (each product needs its own — say so), batch/lab results, certificate values, aliases, labels, invoices. Shows a card first; nothing is created until the user presses Copy.",
  args: z.object({
    sourceProductId: id("product to copy"),
    targetBrandId: id("brand to copy to"),
    name: z.string().trim().min(2).max(300).describe("The new product's name, as the user gave it"),
    productCode: z.string().max(120).optional(),
    fieldGroups: groupsArg,
    keepLinked: keepLinkedArg,
  }),
  preview: async (a, ctx) => {
    const src = await sourceOf(a.sourceProductId, ctx);
    const brand = await targetBrandOf(a.targetBrandId, ctx);
    const fields = resolveFields(a.fieldGroups);
    const same = await prisma.product.findFirst({ where: { companyId: ctx.companyId, brandId: brand.id, name: { equals: a.name, mode: "insensitive" } }, select: { id: true } });
    return {
      title: `Copy ${src.name} to ${brand.name}`,
      summary: `A new product ${a.name} is created in ${brand.name} with ${src.name}'s product data. The registration number is not copied — the new product needs its own.`,
      runLabel: "Copy",
      details: [
        { label: "From", value: `${label(src)}${src.companyId !== ctx.companyId ? ` · ${src.company.name}` : ""}` },
        { label: "To brand", value: `${brand.name} · ${brand.company.name}` },
        { label: "New name", value: a.name },
        ...(a.productCode ? [{ label: "Product code", value: a.productCode }] : []),
        { label: "Fields copied", value: `${groupsLine(a.fieldGroups)} (${fields.length} fields)` },
        { label: "Registration number", value: "not copied — needs its own registration number" },
        { label: "Linked to the original", value: a.keepLinked === false ? "no" : "yes" },
      ],
      aiCalls: null,
      missing: same ? [`${brand.name} already has a product named ${a.name}`] : [],
    };
  },
  run: async (a, ctx) => {
    const out = await copyProduct(a.sourceProductId, { targetCompanyId: ctx.companyId, targetBrandId: a.targetBrandId, name: a.name, productCode: a.productCode, fieldsToCopy: a.fieldGroups, keepLinked: a.keepLinked }, actorOf(ctx));
    return {
      productId: out.product.id,
      name: out.product.name,
      brand: out.product.brand?.name,
      copiedFields: out.copied,
      registrationNumber: "not copied — the new product needs its own",
      link: `/products/${out.product.id}`,
      ref: { type: "product", id: out.product.id, name: out.product.name },
    };
  },
});

defineTool({
  name: "copy_products_to_brand",
  module: "products",
  risk: "write",
  permissions: ["create_products"],
  label: "Copying the products",
  description:
    "Proposes copying several products to one brand at once, each under its own new name: products [{ productId, name, productCode? }] (ids from search_products, names from the user). " +
    "Same data and rules as copy_product_to_brand (registration numbers are never copied). One card for all; each product is copied on its own and reported on its own.",
  args: z.object({
    targetBrandId: id("brand to copy to"),
    products: z.array(z.object({ productId: id("product to copy"), name: z.string().trim().min(2).max(300), productCode: z.string().max(120).optional() })).min(1).max(50),
    fieldGroups: groupsArg,
    keepLinked: keepLinkedArg,
  }),
  preview: async (a, ctx) => {
    const brand = await targetBrandOf(a.targetBrandId, ctx);
    const rows = [];
    for (const p of a.products) rows.push({ src: await sourceOf(p.productId, ctx), ...p });
    return {
      title: `Copy ${rows.length} product${rows.length === 1 ? "" : "s"} to ${brand.name}`,
      summary: `${rows.length} new product${rows.length === 1 ? " is" : "s are"} created in ${brand.name}, each with its original's product data. Registration numbers are not copied.`,
      runLabel: "Copy all",
      details: [
        { label: "To brand", value: `${brand.name} · ${brand.company.name}` },
        ...rows.map((r) => ({ label: label(r.src), value: `→ ${r.name}${r.productCode ? ` · ${r.productCode}` : ""}` })),
        { label: "Fields copied", value: groupsLine(a.fieldGroups) },
        { label: "Registration number", value: "not copied — each new product needs its own" },
        { label: "Linked to the originals", value: a.keepLinked === false ? "no" : "yes" },
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const out = await copyProductsBulk(
      { productIds: a.products.map((p) => p.productId), targetCompanyId: ctx.companyId, targetBrandId: a.targetBrandId, names: a.products, fieldsToCopy: a.fieldGroups, keepLinked: a.keepLinked },
      actorOf(ctx)
    );
    return {
      copied: out.copied,
      failed: out.failed,
      results: out.results.map((r) => (r.ok ? { from: r.productId, productId: r.product.id, name: r.product.name, link: `/products/${r.product.id}` } : { from: r.productId, error: r.error })),
      registrationNumber: "not copied — each new product needs its own",
    };
  },
});

defineTool({
  name: "get_copy_source_diff",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  label: "Comparing with the original",
  description:
    "For a product copied from another brand's product (linked copy): every product-data field where the copy and its original differ now, original value vs copy value. " +
    "Show it to the user before update_copy_from_source and let them pick the fields. Nothing changes.",
  args: z.object({ productId: id("copied product") }),
  run: async (a, ctx) => {
    const d = await diffFromSource(a.productId, ctx.isSystem && !ctx.companyId ? null : ctx.companyId);
    return { original: d.source, copy: d.copy, differences: d.fields.filter((f) => !f.same).map((f) => ({ field: f.field, group: f.group, original: f.source, copy: f.copy })), sameFields: d.fields.filter((f) => f.same).length };
  },
});

defineTool({
  name: "update_copy_from_source",
  module: "products",
  risk: "write",
  permissions: ["update_products"],
  label: "Updating from the original",
  description:
    "Proposes taking the original's current value for the fields the user picked, on a linked copy (see get_copy_source_diff first). fields: product field names the user chose " +
    `(${COPYABLE_FIELDS.join(", ")}). Only those fields change; never the registration number. Shows a card with original → copy for each field.`,
  args: z.object({ productId: id("copied product"), fields: z.array(z.enum(COPYABLE_FIELDS)).min(1).max(COPYABLE_FIELDS.length) }),
  preview: async (a, ctx) => {
    const d = await diffFromSource(a.productId, ctx.isSystem ? null : ctx.companyId);
    const show = (v) => (v === null || v === undefined || (Array.isArray(v) && !v.length) ? "—" : typeof v === "object" ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300));
    const picked = d.fields.filter((f) => a.fields.includes(f.field));
    return {
      title: `Update ${d.copy.name} from ${d.source.name}`,
      summary: `${picked.length} field${picked.length === 1 ? "" : "s"} of ${d.copy.name} take the original's current value; every other field stays as it is.`,
      runLabel: "Update",
      details: picked.map((f) => ({ label: f.field, value: f.same ? "already the same" : `${show(f.copy)} → ${show(f.source)}` })),
      aiCalls: null,
      missing: picked.every((f) => f.same) ? ["These fields are already the same as the original"] : [],
    };
  },
  run: async (a, ctx) => {
    const out = await updateFromSource(a.productId, a.fields, actorOf(ctx));
    return { productId: out.product.id, name: out.product.name, updated: out.updated, link: `/products/${out.product.id}`, ref: { type: "product", id: out.product.id, name: out.product.name } };
  },
});
