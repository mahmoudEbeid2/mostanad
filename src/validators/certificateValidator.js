import { z } from "zod";

export const generateCertificatesSchema = {
  params: z.object({
    companyId: z.string().uuid("Invalid company ID format").optional(),
  }),
  body: z.object({
    brandId: z.string().uuid("Invalid brand ID format").optional().nullable(),
    transactionType: z.enum(["shipping", "registration"], {
      required_error: "transactionType is required and must be either 'shipping' or 'registration'",
    }),
  }),
};
