import { z } from "zod";

export const createCompanySchema = {
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name must not exceed 100 characters"),

    username: z
      .string({ required_error: "Username is required" })
      .min(3, "Username must be at least 3 characters")
      .max(30, "Username must not exceed 30 characters")
      .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),

    password: z
      .string({ required_error: "Password is required" })
      .min(6, "Password must be at least 6 characters"),

    email: z.string().email("Invalid email format").optional().nullable(),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    logoUrl: z.string().optional().nullable(),
  }),
};

export const updateCompanySchema = {
  params: z.object({
    id: z.string().uuid("Invalid company ID format"),
  }),
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
      .optional(),
    password: z.string().min(6).optional(),
    email: z.string().email("Invalid email format").optional().nullable(),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    logoUrl: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
  }),
};

export const getCompanyByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid company ID format"),
  }),
};

export const deleteCompanySchema = {
  params: z.object({
    id: z.string().uuid("Invalid company ID format"),
  }),
};
