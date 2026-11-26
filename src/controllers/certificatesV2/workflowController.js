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
import { enqueueTask, QUEUES } from "../../services/certificates/jobs/queues.js";
import { acceptEstimates as acceptProductEstimates } from "../../services/harvest/harvestInfer.js";
import { listSchemes, setScheme } from "../../services/certificates/generation/docNumbers.js";

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
export const setRequestOptions = catchAsync(async (req, res) => ok(res, await requests.setRequestOptions(req.params.id, scopeOf(req), parse(z.object({ issueDate: z.string().nullable() }), req.body))));

/** GET /companies/:id/numbering — the company's certificate numbering per type, each with its next number */
export const getNumbering = catchAsync(async (req, res, next) => {
  const companyId = req.company ? req.company.id : req.params.id;
  if (req.company && req.params.id !== req.company.id) return next(new AppError("Company not found!", 404));
  ok(res, { schemes: await listSchemes(companyId) });
});
/** PUT /companies/:id/numbering/:code { pattern, lastSeq? } — a person sets (or confirms) a type's numbering */
export const setNumbering = catchAsync(async (req, res, next) => {
  const companyId = req.company ? req.company.id : req.params.id;
  if (req.company && req.params.id !== req.company.id) return next(new AppError("Company not found!", 404));
  const body = parse(z.object({ pattern: z.string().min(3).max(60), lastSeq: z.number().int().min(0).optional() }), req.body);
  try {
    await setScheme(companyId, req.params.code, body, actorId(req));
  } catch (err) {
    return next(new AppError(err.message, err.statusCode || 400));
  }
  ok(res, { schemes: await listSchemes(companyId) });
});

export const generateRequest = catchAsync(async (req, res) => ok(res, await requests.generateRequest(req.params.id, scopeOf(req), actorId(req)), 202));

const reviewBody = z.object({ action: z.enum(["submit", "pass", "return", "authorize", "override_spec"]), field: z.string().max(80).optional(), comment: z.string().max(1000).optional(), expectedVersion: z.number().int().optional() });
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

// ── harvest (28 Nov): read every stored file again; what was read for a product, with its evidence ──
/** POST /companies/:id/harvest → 202 { taskId } — a company account only for itself */
export const reharvest = catchAsync(async (req, res, next) => {
  const companyId = req.company ? req.company.id : req.params.id;
  if (req.company && req.params.id !== req.company.id) return next(new AppError("Company not found!", 404));
  if (!(await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }))) return next(new AppError("Company not found!", 404));
  const task = await enqueueTask({ queueName: QUEUES.template, jobName: "reharvestCompany", type: "company_reharvest", companyId, data: { entity: "company", entityId: companyId, companyId } });
  ok(res, { taskId: task.id }, 202);
});

/** GET /products/:id/harvest → { facts: [{ key, value, sourceType, file, page, snippet, link }], conflicts, perBatch } */
export const productHarvest = catchAsync(async (req, res, next) => {
  const companyId = scopeOf(req);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, ...(companyId ? { companyId } : {}) }, select: { id: true, harvestConflicts: true } });
  if (!p) return next(new AppError("Product not found!", 404));
  const facts = await prisma.harvestedFact.findMany({ where: { productId: p.id }, orderBy: [{ perBatch: "asc" }, { key: "asc" }] });
  const view = (f) => ({ id: f.id, key: f.key, value: f.value, sourceType: f.sourceType, certCode: f.certCode, file: f.fileName, page: f.page, snippet: f.snippet, batchNo: f.batchNo, extractor: f.extractor, needsReview: f.reviewStatus !== "confirmed" ? f.verifyNote || true : undefined, link: f.fileId ? `/api/v1/evidence-files/${f.fileId}${f.page ? `#page=${f.page}` : ""}` : null });
  // what was estimated (Part B): printed marked «مستنتج» until accepted
  const prov = (await prisma.product.findUnique({ where: { id: p.id }, select: { fieldProvenance: true } }))?.fieldProvenance || {};
  const estimates = Object.entries(prov).filter(([, v]) => v?.estimated === true && v.printable === true).map(([path, v]) => ({ path, basis: v.basis, reasoning: v.reasoning || null, modelId: v.modelId, accepted: !!v.confirmedAt, at: v.at }));
  ok(res, { facts: facts.filter((f) => !f.perBatch).map(view), perBatch: facts.filter((f) => f.perBatch).map(view), conflicts: p.harvestConflicts || [], estimates });
});

/**
 * POST /products/estimates/accept { productIds?, certificateIds? } — «اعتمد كل المستنتج»: a person
 * accepts every printed estimate of these products (or of these certificates' products); the drafts'
 * «مستنتج» marks are cleared (the value and the version stay as they are).
 */
export const acceptEstimates = catchAsync(async (req, res, next) => {
  const companyId = scopeOf(req);
  const certIds = Array.isArray(req.body?.certificateIds) ? req.body.certificateIds.slice(0, 2000) : [];
  const certs = certIds.length ? await prisma.certificate.findMany({ where: { id: { in: certIds }, ...(companyId ? { companyId } : {}) }, select: { id: true, productId: true, companyId: true } }) : [];
  const productIds = [...new Set([...(Array.isArray(req.body?.productIds) ? req.body.productIds.slice(0, 2000) : []), ...certs.map((c) => c.productId).filter(Boolean)])];
  if (!productIds.length) return next(new AppError("Send productIds or certificateIds", 400));
  const owners = await prisma.product.findMany({ where: { id: { in: productIds }, ...(companyId ? { companyId } : {}) }, select: { id: true, companyId: true } });
  const userId = req.user?.id || null;
  let accepted = 0;
  for (const cid of new Set(owners.map((o) => o.companyId))) {
    const r = await acceptProductEstimates({ companyId: cid, productIds: owners.filter((o) => o.companyId === cid).map((o) => o.id), userId });
    accepted += r.accepted;
  }
  // the drafts' marks: every certificate of these products (or the ones named), latest version
  const targets = certs.length ? certs : await prisma.certificate.findMany({ where: { productId: { in: owners.map((o) => o.id) }, status: { not: "final" } }, select: { id: true } });
  let cleared = 0;
  const at = new Date().toISOString();
  for (const t of targets) {
    const v = await prisma.certificateVersion.findFirst({ where: { certificateId: t.id }, orderBy: { versionNumber: "desc" }, select: { id: true, values: true } });
    if (!v?.values) continue;
    let n = 0;
    const values = Object.fromEntries(
      Object.entries(v.values).map(([k, x]) => {
        if (!(x?.flags || []).includes("estimated")) return [k, x];
        n++;
        return [k, { ...x, flags: x.flags.filter((f) => f !== "estimated"), provenance: { ...(x.provenance || {}), confirmedAt: at, confirmedByUserId: userId, acceptedInBulk: true } }];
      })
    );
    if (n) {
      await prisma.certificateVersion.update({ where: { id: v.id }, data: { values } });
      cleared += n;
    }
  }
  ok(res, { products: owners.length, accepted, certificates: targets.length, marksCleared: cleared });
});

/**
 * POST /products/:id/harvest/conflicts/:key { value } — the person settles a conflict: the chosen
 * value is theirs (provenance user — no file overwrites it), the conflict keeps both sources and the decision.
 */
export const decideConflict = catchAsync(async (req, res, next) => {
  const companyId = scopeOf(req);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, ...(companyId ? { companyId } : {}) } });
  if (!p) return next(new AppError("Product not found!", 404));
  const conflicts = [...(p.harvestConflicts || [])];
  const i = conflicts.findIndex((c) => c.key === req.params.key && !c.decision);
  if (i < 0) return next(new AppError("No open conflict for this field", 404));
  const value = String(req.body?.value ?? "").trim();
  if (!value) return next(new AppError("Send the chosen value", 400));
  const COLUMNS = { physicalForm: "physicalForm", packaging: "packaging", validity: "validity", storage: "storage", indications: "indications", dosage: "dosage", withdrawalPeriod: "withdrawalPeriod", contraindications: "contraindications", appearance: "appearance", compositionBasis: "compositionBasis", origin: "origin", category: "productType", routeOfAdmin: "routeOfAdmin", registrationNumber: "registrationNumber", productCode: "productCode" };
  const col = COLUMNS[req.params.key];
  const data = {};
  const prov = { ...(p.fieldProvenance || {}) };
  if (col) {
    data[col] = value;
    prov[col] = { tier: "manual", source: "user", by: req.user?.id || null, at: new Date().toISOString(), chosenFromConflict: true };
  }
  conflicts[i] = { ...conflicts[i], decision: { value, by: req.user?.id || null, at: new Date().toISOString() } };
  await prisma.product.update({ where: { id: p.id }, data: { ...data, fieldProvenance: prov, harvestConflicts: conflicts } });
  ok(res, { key: req.params.key, value, applied: !!col });
});
