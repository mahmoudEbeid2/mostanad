import { z } from "zod";

export const createRoleSchema = {
  body: z.object({
    name: z
      .string({ required_error: "Role name is required" })
      .min(2, "Role name must be at least 2 characters long")
      .max(50, "Role name must not exceed 50 characters"),
    description: z.string().max(255, "Description must not exceed 255 characters").optional(),
    permissions: z.array(z.string().uuid("Invalid permission ID format")).optional(),
    permissionSlugs: z.array(z.string()).optional(),
  }),
};

export const updateRoleSchema = {
  params: z.object({
    id: z.string().uuid("Invalid role ID format"),
  }),
  body: z.object({
    name: z
      .string()
      .min(2, "Role name must be at least 2 characters long")
      .max(50, "Role name must not exceed 50 characters")
      .optional(),
    description: z.string().max(255, "Description must not exceed 255 characters").optional(),
    permissions: z.array(z.string().uuid("Invalid permission ID format")).optional(),
    permissionSlugs: z.array(z.string()).optional(),
  }),
};

export const getRoleByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid role ID format"),
  }),
};

export const deleteRoleSchema = {
  params: z.object({
    id: z.string().uuid("Invalid role ID format"),
  }),
};
