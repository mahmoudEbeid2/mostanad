import { z } from "zod";

// Shared argument pieces for tool schemas.
export const pageArgs = {
  page: z.number().int().min(1).optional().describe("Page number, from 1. Use the nextPage a previous result gave."),
  limit: z.number().int().min(1).max(25).optional().describe("Rows per page (max 25, default 10)."),
};
export const id = (what) => z.string().uuid().describe(`The ${what} id (a uuid from an earlier tool result)`);
export const dateArg = (what) => z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe(`${what}, ISO date YYYY-MM-DD (UTC)`);
export const pg = (a) => ({ page: a.page || 1, limit: a.limit || 10 });
