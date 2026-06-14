import { z } from "zod";

export const createTemplateSchema = {
  params: z.object({
    companyId: z.string().uuid("Invalid company ID format"),
  }),
  body: z.object({
    name: z
      .string({ required_error: "Template name is required" })
      .min(2, "Template name must be at least 2 characters"),
    type: z
      .string({ required_error: "Template type is required" })
      .min(2, "Template type must be at least 2 characters"),
    htmlContent: z
      .string({ required_error: "HTML content is required" })
      .min(1, "HTML content cannot be empty"),
    brandId: z.string().uuid("Invalid brand ID format").optional().nullable(),
    isActive: z.boolean().optional(),
  }),
};

export const updateTemplateSchema = {
  params: z.object({
    id: z.string().uuid("Invalid template ID format"),
  }),
  body: z.object({
    name: z.string().min(2).optional(),
    type: z.string().min(2).optional(),
    htmlContent: z.string().min(1).optional(),
    brandId: z.string().uuid("Invalid brand ID format").optional().nullable(),
    isActive: z.boolean().optional(),
  }),
};

export const getTemplateByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid template ID format"),
  }),
};

export const deleteTemplateSchema = {
  params: z.object({
    id: z.string().uuid("Invalid template ID format"),
  }),
};
