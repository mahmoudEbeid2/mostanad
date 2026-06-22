import { z } from "zod";

export const loginSchema = {
  body: z.object({
    username: z
      .string({ required_error: "Username or email is required" })
      .min(2, "Username or email must be at least 2 characters"),
    password: z
      .string({ required_error: "Password is required" })
      .min(6, "Password must be at least 6 characters"),
  }),
};
