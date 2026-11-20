import { z } from "zod";
import { defineTool } from "../registry.js";
import { page, pick, ref } from "../trim.js";
import { pageArgs, id, pg } from "./common.js";
import { getAllProducts, getProductById } from "../../../productService.js";
import { searchProductsForAssistant } from "../../productSearch.js";
import { productsMissingData, PRODUCT_FIELDS, listBrands, getBrand } from "../../reads.js";
import { listProfile } from "../../../certificates/dataNeeds/productProfile.js";
import { getAllCategories } from "../../../categoryService.js";

const PRODUCT_DETAIL = [
  "id", "name", "productCode", "description", "indications", "targetSpecies", "physicalForm", "appearance", "activeIngredients", "dosage", "mixingInstructions",
  "withdrawalPeriod", "contraindications", "userSafety", "storage", "packaging", "registrationNumber", "origin", "producer", "specifications",
  "routeOfAdmin", "dosageForm", "strength", "productType", "prescriptionStatus", "companyId", "createdAt", "updatedAt",
];

defineTool({
  name: "search_products",
  module: "products",
  core: true,
  risk: "read",
  permissions: ["read_products"],
  label: "Searching products",
  description:
    "Find products by name or code — the first step for any question about a specific product. Pass every spelling you can think of in `queries` (the user's text, Arabic and English forms, close spellings, the code). " +
    "Matches by exact code, saved aliases, fuzzy name similarity and catalogue text. Returns up to 5 products with a score 0–1 and a verdict: " +
    "clear (matched exactly by code, saved alias or full name — use it), close (only similar names: it is NOT the product asked for — say \"I didn't find X; the closest is Y\" and ask; the user is shown buttons), " +
    "none (say nothing matched).",
  args: z.object({
    queries: z.array(z.string().min(1).max(120)).min(1).max(6).describe("Spellings to search together, e.g. [\"فيتامينول\", \"Vitaminol\", \"vitaminol\"]"),
  }),
  run: (a, ctx) => searchProductsForAssistant({ companyId: ctx.companyId, queries: a.queries }),
});

defineTool({
  name: "get_product",
  module: "products",
  core: true,
  risk: "read",
  permissions: ["read_products"],
  label: "Reading the product",
  description:
    "The full stored record of one product: code, composition (activeIngredients), specifications, dosage, withdrawal period, storage, packaging, registration, brand, category, company. " +
    "Use it to answer what a product contains or what is recorded for it. An empty field means nothing is stored — say so; never fill it in.",
  args: z.object({ productId: id("product") }),
  run: async (a, ctx) => {
    const p = await getProductById(a.productId, ctx.companyId || undefined);
    return { ...pick(p, PRODUCT_DETAIL), brand: p.brand ? { id: p.brand.id, name: p.brand.name } : null, category: p.category ? { id: p.category.id, name: p.category.name } : null, company: p.company, ref: ref("product", p) };
  },
});

defineTool({
  name: "list_products",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  label: "Listing products",
  description: "A page of products, optionally filtered by brand or category, newest first (or by name). For finding one product by name use search_products instead.",
  args: z.object({
    brandId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    sort: z.enum(["name", "-createdAt"]).optional(),
    ...pageArgs,
  }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const qs = { page: String(p), limit: String(limit), sort: a.sort || "-createdAt", ...(a.brandId ? { brandId: a.brandId } : {}), ...(a.categoryId ? { categoryId: a.categoryId } : {}) };
    const { meta, products } = await getAllProducts(qs, ctx.companyId || undefined);
    const items = products.map((x) => ({ id: x.id, name: x.name, productCode: x.productCode, brand: x.brand?.name || null, company: x.company?.name, ref: ref("product", x) }));
    return page(items, meta?.total, { page: p, limit });
  },
});

defineTool({
  name: "list_products_missing_data",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  label: "Checking product data",
  description:
    "Products where stored data is missing: any of `fields` empty, and/or no value for the specification named `specification` (e.g. \"pH\", \"Assay\", \"Moisture\"). " +
    `Fields: ${PRODUCT_FIELDS.join(", ")}. Returns the products with what each is missing, and how many products were checked.`,
  args: z.object({
    fields: z.array(z.enum(PRODUCT_FIELDS)).max(10).optional(),
    specification: z.string().min(1).max(60).optional(),
    brandId: z.string().uuid().optional(),
    ...pageArgs,
  }),
  run: async (a, ctx) => {
    if (!a.fields?.length && !a.specification) return { error: "Pass fields and/or specification." };
    const { page: p, limit } = pg(a);
    const r = await productsMissingData(ctx.companyId, { ...a, page: p, limit });
    const items = r.rows.map((x) => ({ ...x, ...(ctx.companyId ? { companyId: undefined, company: undefined } : {}), ref: ref("product", x) }));
    return { checked: r.checked, ...page(items, r.total, { page: p, limit }) };
  },
});

defineTool({
  name: "get_product_certificate_values",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  needsCompany: true,
  label: "Reading saved certificate values",
  description: "Values saved for a product from earlier certificates (its certificate profile): label, value, where it came from, whether it was an estimate a person confirmed.",
  args: z.object({ productId: id("product") }),
  run: async (a, ctx) => {
    await getProductById(a.productId, ctx.companyId);
    const rows = await listProfile(ctx.companyId, a.productId);
    return { total: rows.length, items: rows.map((r) => ({ label: r.label, value: r.value, estimated: r.estimated, source: r.provenance?.kind || r.provenance?.tier || null, updatedAt: r.updatedAt })) };
  },
});

defineTool({
  name: "list_brands",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  label: "Listing brands",
  description: "Brands, with how many products each has. Optional `q` filters by name.",
  args: z.object({ q: z.string().max(80).optional(), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, rows } = await listBrands(ctx.companyId, { q: a.q, page: p, limit });
    return page(rows.map((b) => ({ id: b.id, name: b.name, isActive: b.isActive, products: b._count.products, ...(ctx.companyId ? {} : { company: b.company.name }) })), total, { page: p, limit });
  },
});

defineTool({
  name: "get_brand",
  module: "products",
  risk: "read",
  permissions: ["read_products"],
  label: "Reading the brand",
  description: "One brand: name, active, company, and how many products, certificate templates and invoices use it.",
  args: z.object({ brandId: id("brand") }),
  run: async (a, ctx) => {
    const b = await getBrand(a.brandId, ctx.companyId);
    return { id: b.id, name: b.name, isActive: b.isActive, company: b.company.name, counts: b._count };
  },
});

defineTool({
  name: "list_categories",
  module: "products",
  risk: "read",
  permissions: ["read_categories"],
  label: "Listing categories",
  description: "Product categories (shared by every company). Optional `q` filters by name.",
  args: z.object({ q: z.string().max(80).optional(), ...pageArgs }),
  companyArg: false,
  run: async (a) => {
    const { page: p, limit } = pg(a);
    const { meta, categories } = await getAllCategories({ page: String(p), limit: String(limit), sort: "name", ...(a.q ? { search: a.q } : {}) });
    return page(categories.map((c) => ({ id: c.id, name: c.name })), meta?.total, { page: p, limit });
  },
});
