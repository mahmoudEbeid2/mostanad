import { z } from "zod";

const activeIngredientSchema = z.object({
  name: z.string({ required_error: "Active ingredient name is required" }).min(1),
  concentration: z.string().min(1).optional().nullable(),
  // catalogue products (A6) keep the printed text and its parse — an edit must not drop them
  amountRaw: z.string().max(200).optional().nullable(),
  amount: z.number().optional().nullable(),
  unit: z.string().max(40).optional().nullable(),
  basis: z.string().max(400).optional().nullable(),
  readAs: z.string().max(40).optional().nullable(),
}).superRefine((i, ctx) => {
  // a typed ingredient needs its concentration; a catalogue one (it carries amountRaw)
  // may have none — the catalogue printed no amount, and a placeholder is never stored
  if (!i.concentration && !("amountRaw" in i)) ctx.addIssue({ code: "custom", path: ["concentration"], message: "Active ingredient concentration is required" });
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
