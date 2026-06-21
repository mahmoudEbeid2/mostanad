import { z } from "zod";

export const verifyLabelSchema = {
  params: z.object({
    companyId: z.string().uuid("Invalid company ID format"),
  }),
  body: z.object({
    country: z
      .string({ required_error: "Country is required" })
      .min(2, "Country name must be at least 2 characters"),
  }),
};
