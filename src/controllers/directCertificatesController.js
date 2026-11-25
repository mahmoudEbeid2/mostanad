import { z } from "zod";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { generateForProducts, BATCH_FACTS } from "../services/certificates/direct/directService.js";

// POST /certificates/for-products — certificates for several products, no invoice.
// body: { certificateTypeIds: [id], products: [{ productId, batch?: { batchNo, productionDate, … } }], country?, dryRun? }
// Batch facts are only ever what the person typed here; a missing one stays a flagged blank.
const body = z.object({
  certificateTypeIds: z.array(z.string().uuid()).min(1).max(10),
  products: z.array(z.object({ productId: z.string().uuid(), batch: z.object(Object.fromEntries(BATCH_FACTS.map((k) => [k, z.string().max(200).nullable().optional()]))).partial().optional() })).min(1).max(100),
  country: z.string().max(60).nullable().optional(),
  dryRun: z.boolean().optional(),
  companyId: z.string().uuid().optional(),
});

export const postForProducts = catchAsync(async (req, res, next) => {
  const parsed = body.safeParse(req.body || {});
  if (!parsed.success) return next(new AppError(`Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 400));
  const companyId = req.company ? req.company.id : parsed.data.companyId;
  if (!companyId) return next(new AppError("Choose the company", 400));
  const out = await generateForProducts({ companyId, userId: req.user?.id || null, ...parsed.data });
  res.status(parsed.data.dryRun ? 200 : 202).json({ status: "success", data: out });
});
