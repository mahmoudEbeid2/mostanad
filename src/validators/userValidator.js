import { z } from "zod";

export const createUserSchema = {
  body: z.object({
    name: z.string({
      required_error: "Name is required",
    })
    .min(2, "Name must be at least 2 characters long")
    .max(100, "Name must not exceed 100 characters"),
    
    email: z.string({
      required_error: "Email is required",
    })
    .email("Invalid email format"),
    
    username: z.string()
    .min(3, "Username must be at least 3 characters long")
    .max(30, "Username must not exceed 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
    .optional(),
    
    password: z.string()
    .min(6, "Password must be at least 6 characters long")
    .optional(),
    
    phone: z.string().optional().nullable(),
  }),
};

export const updateUserSchema = {
  params: z.object({
    id: z.string().uuid("Invalid user ID format"),
  }),
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters long").max(100, "Name must not exceed 100 characters").optional(),
    email: z.string().email("Invalid email format").optional(),
    username: z.string().min(3, "Username must be at least 3 characters long").max(30, "Username must not exceed 30 characters").regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores").optional(),
    password: z.string().min(6, "Password must be at least 6 characters long").optional(),
    phone: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
  }),
};

export const getUserByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid user ID format"),
  }),
};

export const deleteUserSchema = {
  params: z.object({
    id: z.string().uuid("Invalid user ID format"),
  }),
};
