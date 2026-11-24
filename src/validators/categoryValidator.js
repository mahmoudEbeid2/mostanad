import { z } from "zod";

export const createCategorySchema = {
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(2, "Name must be at least 2 characters long")
      .max(50, "Name must not exceed 50 characters"),
    // the main category this one sits under; null / "" = a main one itself
    parentId: z.union([z.string().uuid("Invalid parent category ID format"), z.literal(""), z.null()]).optional(),
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
    // the main category this one sits under; null / "" = a main one itself
    parentId: z.union([z.string().uuid("Invalid parent category ID format"), z.literal(""), z.null()]).optional(),
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
