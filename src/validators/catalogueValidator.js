import { z } from "zod";

// Request schemas for the product-catalogue API (plan.md §15, A6).
// Multipart bodies arrive as strings — empty strings mean "not set".

const uuid = z.string().uuid();
const optionalUuid = z
  .union([uuid, z.literal(""), z.literal("null")])
  .optional()
  .nullable()
  .transform((v) => (v === undefined || v === null || v === "" || v === "null" ? null : v));
const optionalText = (max) => z.string().trim().max(max).optional().nullable();
const companyQuery = z.object({ companyId: uuid.optional() }).passthrough();
// multipart "true"/"false" (or a JSON boolean); absent = the default (true)
const flag = z.union([z.boolean(), z.enum(["true", "false"])]).optional().transform((v) => (v === undefined ? undefined : v === true || v === "true"));
const idParams = z.object({ id: uuid });

export const catalogueSchemas = {
  upload: {
    query: companyQuery,
    body: z.object({ companyId: uuid.optional(), manufacturer: optionalText(120), brandId: optionalUuid, label: optionalText(80), extract: flag }),
  },
  uploadVersion: { params: idParams, query: companyQuery, body: z.object({ label: optionalText(80), extract: flag }) },
  extract: { params: idParams, query: companyQuery, body: z.object({ infer: flag, blockIds: z.array(uuid).min(1).max(200).optional() }).optional() },
  convention: { params: idParams, query: companyQuery, body: z.object({ dotGroup3: z.enum(["thousands", "decimal"]) }) },
  // C1 choose pages: the range (1..pageCount, at least one) is checked by the service against the file
  pageSelection: { params: idParams, query: companyQuery, body: z.object({ pages: z.array(z.number().int()).max(5000) }) },
  pageImage: { params: z.object({ id: uuid, n: z.coerce.number().int().min(1).max(5000) }), query: z.object({ companyId: uuid.optional(), size: z.enum(["thumb", "large"]).optional() }).passthrough() },
  list: { query: companyQuery },
  byId: { params: idParams, query: companyQuery },
  link: { params: idParams, query: companyQuery, body: z.object({ productId: uuid }) },
  // A6.4 review: typed values are text or a list of text; null clears a typed value
  editBlock: {
    params: idParams,
    query: companyQuery,
    body: z
      .object({
        values: z.record(z.string().max(40), z.union([z.string().max(4000), z.array(z.string().max(400)).max(50), z.null()])).optional(),
        categoryId: z.union([uuid, z.null()]).optional(),
      })
      .refine((b) => b.values !== undefined || b.categoryId !== undefined, { message: "values or categoryId is required" }),
  },
  decide: { params: idParams, query: companyQuery },
  merge: { params: idParams, query: companyQuery, body: z.object({ blockIds: z.array(uuid).length(2) }) },
  split: { params: idParams, query: companyQuery, body: z.object({ atLine: z.number().int().min(1) }) },
  // A6.5 re-upload diff: per product (no fields → every non-conflict change) or per field
  // A6.6 search: a company session is always scoped to itself; a system user passes companyId
  search: {
    query: z
      .object({ q: z.string().trim().min(1).max(200), companyId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional(), allVersions: z.enum(["true", "false"]).optional() })
      .passthrough(),
  },
  applyDiff: { params: idParams, query: companyQuery, body: z.object({ fields: z.array(z.string().max(40)).max(40).optional(), productId: uuid.optional() }).optional() },
};
