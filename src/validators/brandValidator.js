import { z } from "zod";

export const createBrandSchema = {
  body: z.object({
    name: z
      .string({ required_error: "Brand name is required" })
      .min(2, "Brand name must be at least 2 characters")
      .max(100, "Brand name must not exceed 100 characters"),

    companyId: z
      .string({ required_error: "Company ID is required" })
      .uuid("Invalid company ID format"),

    logoUrl: z.string().optional().nullable(),
  }),
};

export const updateBrandSchema = {
  params: z.object({
    id: z.string().uuid("Invalid brand ID format"),
  }),
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    companyId: z.string().uuid("Invalid company ID format").optional(),
    logoUrl: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
  }),
};

export const getBrandByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid brand ID format"),
  }),
};

export const deleteBrandSchema = {
  params: z.object({
    id: z.string().uuid("Invalid brand ID format"),
  }),
};
