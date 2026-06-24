import { z } from "zod";

const activeIngredientSchema = z.object({
  name: z.string({ required_error: "Active ingredient name is required" }).min(1),
  concentration: z.string({ required_error: "Active ingredient concentration is required" }).min(1),
});

const specificationsSchema = z.object({
  type: z.string({ required_error: "Specifications type is required" }).min(1),
  values: z.record(z.string(), z.string(), { required_error: "Specifications values are required" }),
});

export const createProductSchema = {
  body: z.object({
    companyId: z.string({ required_error: "Company ID is required" }).uuid("Invalid company ID format"),
    name: z
      .string({ required_error: "Product name is required" })
      .min(2, "Product name must be at least 2 characters"),
    productCode: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    indications: z.string().optional().nullable(),
    targetSpecies: z.array(z.string()).optional(),
    physicalForm: z.string().optional().nullable(),
    appearance: z.string().optional().nullable(),
    activeIngredients: z.array(activeIngredientSchema).optional().nullable(),
    dosage: z.string().optional().nullable(),
    mixingInstructions: z.string().optional().nullable(),
    withdrawalPeriod: z.string().optional().nullable(),
    contraindications: z.string().optional().nullable(),
    userSafety: z.array(z.string()).optional(),
    storage: z.string().optional().nullable(),
    packaging: z.string().optional().nullable(),
    registrationNumber: z.string().optional().nullable(),
    origin: z.string().optional().nullable(),
    producer: z.string().optional().nullable(),
    specifications: specificationsSchema.optional().nullable(),
    categoryId: z.string().uuid("Invalid category ID format").optional().nullable(),
    brandId: z.string().uuid("Invalid brand ID format").optional().nullable(),
  }),
};

export const updateProductSchema = {
  params: z.object({
    id: z.string().uuid("Invalid product ID format"),
  }),
  body: z.object({
    name: z.string().min(2).optional(),
    productCode: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    indications: z.string().optional().nullable(),
    targetSpecies: z.array(z.string()).optional(),
    physicalForm: z.string().optional().nullable(),
    appearance: z.string().optional().nullable(),
    activeIngredients: z.array(activeIngredientSchema).optional().nullable(),
    dosage: z.string().optional().nullable(),
    mixingInstructions: z.string().optional().nullable(),
    withdrawalPeriod: z.string().optional().nullable(),
    contraindications: z.string().optional().nullable(),
    userSafety: z.array(z.string()).optional(),
    storage: z.string().optional().nullable(),
    packaging: z.string().optional().nullable(),
    registrationNumber: z.string().optional().nullable(),
    origin: z.string().optional().nullable(),
    producer: z.string().optional().nullable(),
    specifications: specificationsSchema.optional().nullable(),
    categoryId: z.string().uuid("Invalid category ID format").optional().nullable(),
    brandId: z.string().uuid("Invalid brand ID format").optional().nullable(),
  }),
};

export const getProductByIdSchema = {
  params: z.object({
    id: z.string().uuid("Invalid product ID format"),
  }),
};

export const deleteProductSchema = {
  params: z.object({
    id: z.string().uuid("Invalid product ID format"),
  }),
};
