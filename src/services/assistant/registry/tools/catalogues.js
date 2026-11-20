import { z } from "zod";
import { defineTool } from "../registry.js";
import { page, ref } from "../trim.js";
import { pageArgs, id, pg } from "./common.js";
import { listCatalogues, getCatalogue, getVersion } from "../../../catalogues/catalogueService.js";
import { searchCatalogues } from "../../../catalogues/searchService.js";

defineTool({
  name: "search_catalogue",
  module: "catalogues",
  risk: "read",
  permissions: ["read_products"],
  needsCompany: true,
  label: "Searching catalogues",
  description:
    "Full-text search over what the company's product catalogues print (composition, specifications, codes, names), latest edition of each catalogue. " +
    "Returns blocks: catalogue, page, product name/code as printed, the linked product if any, a snippet with matched words in [[ ]], and a score. Use it when a fact isn't in the product record.",
  args: z.object({ q: z.string().min(2).max(120), allVersions: z.boolean().optional(), limit: z.number().int().min(1).max(25).optional() }),
  run: async (a, ctx) => {
    const { results } = await searchCatalogues(ctx.companyId, a.q, { limit: a.limit || 10, allVersions: !!a.allVersions });
    return {
      total: results.length,
      items: results.map((r) => ({ blockId: r.blockId, catalogue: r.manufacturer, edition: r.versionLabel, versionId: r.versionId, page: r.page, name: r.name, productCode: r.productCode, productId: r.productId, snippet: r.snippet, match: r.match, score: r.score, ...(r.productId ? { ref: ref("product", { id: r.productId }, r.name) } : {}) })),
    };
  },
});

defineTool({
  name: "list_catalogues",
  module: "catalogues",
  risk: "read",
  permissions: ["read_products"],
  label: "Listing catalogues",
  description: "Product catalogues (one per manufacturer) with their editions: label, status, pages, when uploaded.",
  args: z.object({ ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const rows = await listCatalogues(ctx.companyId || undefined);
    const items = rows.map((c) => ({
      id: c.id, manufacturer: c.manufacturer, brand: c.brand?.name || null, ...(ctx.companyId ? {} : { company: c.company?.name }),
      editions: c.versions.map((v) => ({ id: v.id, label: v.label, status: v.status, pages: v.pages, createdAt: v.createdAt })),
      ref: ref("catalogue", c, c.manufacturer),
    }));
    return page(items.slice((p - 1) * limit, p * limit), items.length, { page: p, limit });
  },
});

defineTool({
  name: "get_catalogue",
  module: "catalogues",
  risk: "read",
  permissions: ["read_products"],
  label: "Reading the catalogue",
  description: "One catalogue and its editions (id, label, status, pages, applied).",
  args: z.object({ catalogueId: id("catalogue") }),
  run: async (a, ctx) => {
    const c = await getCatalogue(a.catalogueId, ctx.companyId || undefined);
    return { id: c.id, manufacturer: c.manufacturer, brand: c.brand?.name || null, company: c.company?.name, editions: c.versions.map((v) => ({ id: v.id, label: v.label, status: v.status, pages: v.pages, appliedAt: v.appliedAt, createdAt: v.createdAt })), ref: ref("catalogue", c, c.manufacturer) };
  },
});

defineTool({
  name: "get_catalogue_version",
  module: "catalogues",
  risk: "read",
  permissions: ["read_products"],
  label: "Reading the catalogue edition",
  description: "One catalogue edition: status, pages, warnings, and its product blocks (page, title, extracted name and code, review status, linked product). Text is cut; use search_catalogue for specific words.",
  args: z.object({ versionId: id("catalogue version"), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const v = await getVersion(a.versionId, ctx.companyId || undefined);
    const blocks = v.blocks.map((b) => ({ id: b.id, page: b.page, kind: b.kind, title: b.title, name: b.extracted?.record?.name || null, productCode: b.extracted?.record?.productCode || null, status: b.status, productId: b.productId, text: b.text ? b.text.slice(0, 300) : null }));
    return { id: v.id, label: v.label, status: v.status, pages: v.pages, warnings: v.warnings, error: v.error || null, catalogue: v.catalogue, blocks: page(blocks.slice((p - 1) * limit, p * limit), blocks.length, { page: p, limit }) };
  },
});
