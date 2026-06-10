import { z } from "zod";

export const createPlanSchema = {
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(2, "Name must be at least 2 characters")
      .max(50, "Name must not exceed 50 characters"),
    
    description: z.string().optional().nullable(),
    
    price: z.preprocess(
      (val) => {
        if (typeof val === "string" && val.trim() !== "") {
          const parsed = parseFloat(val);
          return isNaN(parsed) ? val : parsed;
        }
        return val;
      },
      z
        .number({ required_error: "Price is required" })
        .nonnegative("Price must be a positive number or zero")
    ),
    
    interval: z.enum(["month", "year"], {
      errorMap: () => ({ message: "Interval must be either 'month' or 'year'" }),
    }),
    
    features: z.array(z.string()).default([]),
  }),
};

export const updatePlanSchema = {
  params: z.object({
    id: z.string().uuid("Invalid plan ID format"),
  }),
  body: z.object({
    name: z.string().min(2).max(50).optional(),
    description: z.string().optional().nullable(),
    price: z.preprocess(
      (val) => {
        if (typeof val === "string" && val.trim() !== "") {
          const parsed = parseFloat(val);
          return isNaN(parsed) ? val : parsed;
        }
        return val;
      },
      z.number().nonnegative("Price must be a positive number or zero").optional()
    ),
    interval: z.enum(["month", "year"]).optional(),
    features: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  }),
};

export const getPlanByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid plan ID format"),
  }),
};

export const deletePlanSchema = {
  params: z.object({
    id: z.string().uuid("Invalid plan ID format"),
  }),
};
