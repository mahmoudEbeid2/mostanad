import { z } from "zod";

export const verifyLabelSchema = {
  body: z.object({
    country: z
      .string({ required_error: "Country is required" })
      .min(2, "Country name must be at least 2 characters"),
  }),
};
