import { z } from "zod";

export const createSubscriptionSchema = {
  body: z.object({
    companyId: z
      .string({ required_error: "Company ID is required" })
      .uuid("Invalid company ID format"),
    
    planId: z
      .string({ required_error: "Plan ID is required" })
      .uuid("Invalid plan ID format"),
    
    startDate: z
      .string()
      .datetime({ message: "Invalid startDate format, must be an ISO datetime string" })
      .optional(),
    
    endDate: z
      .string()
      .datetime({ message: "Invalid endDate format, must be an ISO datetime string" })
      .optional(),
    
    status: z
      .enum(["active", "expired", "cancelled"], {
        errorMap: () => ({ message: "Status must be one of 'active', 'expired', or 'cancelled'" }),
      })
      .default("active"),
  }),
};

export const updateSubscriptionSchema = {
  params: z.object({
    id: z.string().uuid("Invalid subscription ID format"),
  }),
  body: z.object({
    planId: z.string().uuid("Invalid plan ID format").optional(),
    
    endDate: z
      .string()
      .datetime({ message: "Invalid endDate format, must be an ISO datetime string" })
      .optional()
      .nullable(),
    
    status: z
      .enum(["active", "expired", "cancelled"], {
        errorMap: () => ({ message: "Status must be one of 'active', 'expired', or 'cancelled'" }),
      })
      .optional(),
  }),
};

export const getSubscriptionByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid subscription ID format"),
  }),
};

export const deleteSubscriptionSchema = {
  params: z.object({
    id: z.string().uuid("Invalid subscription ID format"),
  }),
};
