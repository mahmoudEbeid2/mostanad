import { z } from "zod";

export const createCategorySchema = {
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(2, "Name must be at least 2 characters long")
      .max(50, "Name must not exceed 50 characters"),
  }),
};

export const updateCategorySchema = {
  params: z.object({
    id: z.string().uuid("Invalid category ID format"),
  }),
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(2, "Name must be at least 2 characters long")
      .max(50, "Name must not exceed 50 characters"),
  }),
};

export const getCategoryByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid category ID format"),
  }),
};

export const deleteCategorySchema = {
  params: z.object({
    id: z.string().uuid("Invalid category ID format"),
  }),
};
