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
const idParams = z.object({ id: uuid });

export const catalogueSchemas = {
  upload: {
    query: companyQuery,
    body: z.object({ companyId: uuid.optional(), manufacturer: optionalText(120), brandId: optionalUuid, label: optionalText(80) }),
  },
  uploadVersion: { params: idParams, query: companyQuery, body: z.object({ label: optionalText(80) }) },
  list: { query: companyQuery },
  byId: { params: idParams, query: companyQuery },
  link: { params: idParams, query: companyQuery, body: z.object({ productId: uuid }) },
};
