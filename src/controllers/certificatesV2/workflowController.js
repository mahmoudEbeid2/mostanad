import { z } from "zod";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/appError.js";
import { prisma } from "../../lib/prisma.js";
import * as fileStore from "../../services/certificates/storage/fileStore.js";
import * as requests from "../../services/certificates/workflow/requestService.js";
import * as review from "../../services/certificates/workflow/reviewService.js";
import * as designer from "../../services/certificates/workflow/designerService.js";
import * as composition from "../../services/catalogues/compositionReview.js";
import { companyFor, scopeOf, actorId } from "./requestScope.js";

// The client's certificate workflow (Dossira_Certificate_Workflow_EN): request → matrix → review →
// delivery, the designer's panel, composition disagreements and the evidence behind a value.

const parse = (schema, data) => {
  const r = schema.safeParse(data || {});
  if (!r.success) throw new AppError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 400);
  return r.data;
};
const ok = (res, data, status = 200) => res.status(status).json({ status: "success", data });

const requestBody = z.object({
  companyId: z.string().uuid().optional(),
  text: z.string().max(20000).optional(),
  lines: z.array(z.object({ productId: z.string().uuid().optional(), name: z.string().max(200).optional(), packing: z.string().max(80).optional(), lotNo: z.string().max(80).optional(), lotSize: z.string().max(40).optional(), lotUnit: z.string().max(20).optional(), quantity: z.string().max(40).optional() })).max(200).optional(),
  certificateCodes: z.array(z.string().min(2).max(10)).max(10).optional(),
  country: z.string().max(60).nullable().optional(),
});
export const createRequest = catchAsync(async (req, res) => ok(res, await requests.createRequest({ companyId: companyFor(req), userId: actorId(req), ...parse(requestBody, req.body) }), 201));
export const getRequest = catchAsync(async (req, res) => ok(res, await requests.getRequest(req.params.id, scopeOf(req))));
export const resolveLine = catchAsync(async (req, res) => ok(res, await requests.resolveLine(req.params.id, scopeOf(req), req.params.lineId, parse(z.object({ productId: z.string().uuid() }), req.body))));
export const generateRequest = catchAsync(async (req, res) => ok(res, await requests.generateRequest(req.params.id, scopeOf(req), actorId(req)), 202));

const reviewBody = z.object({ action: z.enum(["submit", "pass", "return", "authorize"]), field: z.string().max(80).optional(), comment: z.string().max(1000).optional(), expectedVersion: z.number().int().optional() });
export const reviewAction = catchAsync(async (req, res) => ok(res, { certificate: await review.reviewAction(req.params.id, scopeOf(req), actorId(req), parse(reviewBody, req.body)) }));
export const reviewChecks = catchAsync(async (req, res) => ok(res, await review.reviewChecks(req.params.id, scopeOf(req))));
export const revise = catchAsync(async (req, res) => ok(res, { certificate: await review.revise(req.params.id, scopeOf(req), actorId(req)) }, 201));
export const changes = catchAsync(async (req, res) => ok(res, await review.changes(req.params.id, scopeOf(req))));

export const designerData = catchAsync(async (req, res) => ok(res, await designer.designerData(req.params.id, scopeOf(req), { requestId: req.query.requestId || null })));
const estimatesBody = z.object({ appearance: z.string().max(200).nullable().optional(), ph: z.string().max(40).nullable().optional(), assumptions: z.string().max(1000).nullable().optional() });
export const saveDesignEstimates = catchAsync(async (req, res) => ok(res, await designer.saveDesignEstimates(req.params.id, scopeOf(req), parse(estimatesBody, req.body), actorId(req))));

export const compositionReview = catchAsync(async (req, res) => ok(res, await composition.getReview(req.params.id, scopeOf(req))));
export const decideComposition = catchAsync(async (req, res) => ok(res, await composition.decide(req.params.id, scopeOf(req), Number(req.params.index), parse(z.object({ chosen: z.number().int(), reason: z.string().max(500) }), req.body), actorId(req))));

/** GET /evidence-files/:id — the source document behind a value (its page via #page=n), the caller's company only */
export const evidenceFile = catchAsync(async (req, res, next) => {
  const companyId = scopeOf(req);
  const row = await prisma.storedFile.findUnique({ where: { id: req.params.id }, select: { id: true, companyId: true } });
  if (!row || (companyId && row.companyId !== companyId) || !row.companyId) return next(new AppError("File not found!", 404));
  const { row: f, buffer } = await fileStore.readFile(row.id, { companyId: row.companyId });
  res.set({ "Content-Type": f.mimeType || "application/octet-stream", "Content-Disposition": `inline; filename="${encodeURIComponent(f.originalName || "source")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" }).send(buffer);
});
