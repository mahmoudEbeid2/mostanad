import catchAsync from "../utils/catchAsync.js";
import { scopeFor, assertCompanyAccess } from "../utils/tenantScope.js";
import * as catalogues from "../services/catalogues/catalogueService.js";
import { setNumberConvention } from "../services/catalogues/extraction/extractionService.js";

// Product catalogues as source documents (plan.md §15, A6). Thin: every rule
// and every tenant check is in services/catalogues/catalogueService.js.

const ok = (res, data, status = 200) => res.status(status).json({ status: "success", data });

export const uploadCatalogue = catchAsync(async (req, res) => {
  const companyId = req.body.companyId || req.validatedQuery?.companyId || null;
  if (companyId) assertCompanyAccess(req, companyId);
  const result = await catalogues.uploadCatalogue({ companyId, manufacturer: req.body.manufacturer, brandId: req.body.brandId, label: req.body.label, extract: req.body.extract, file: req.file, userId: req.company ? null : req.user?.id });
  ok(res, { catalogueId: result.catalogue.id, versionId: result.version.id, jobId: result.taskId }, 202);
});

export const uploadVersion = catchAsync(async (req, res) => {
  const result = await catalogues.uploadVersion(req.params.id, scopeFor(req), { label: req.body.label, extract: req.body.extract, file: req.file, userId: req.company ? null : req.user?.id });
  ok(res, { catalogueId: result.catalogue.id, versionId: result.version.id, jobId: result.taskId }, 202);
});

export const listCatalogues = catchAsync(async (req, res) => ok(res, { catalogues: await catalogues.listCatalogues(scopeFor(req)) }));
export const getCatalogue = catchAsync(async (req, res) => ok(res, { catalogue: await catalogues.getCatalogue(req.params.id, scopeFor(req)) }));
export const getVersion = catchAsync(async (req, res) => ok(res, { version: await catalogues.getVersion(req.params.id, scopeFor(req)) }));
export const getBlock = catchAsync(async (req, res) => ok(res, { block: await catalogues.getBlock(req.params.id, scopeFor(req)) }));
export const linkBlock = catchAsync(async (req, res) => ok(res, await catalogues.linkBlock(req.params.id, scopeFor(req), req.body.productId)));
export const extractVersion = catchAsync(async (req, res) => ok(res, await catalogues.requestExtraction(req.params.id, scopeFor(req), { infer: req.body?.infer }), 202));
export const putNumberConvention = catchAsync(async (req, res) => ok(res, await setNumberConvention(req.params.id, scopeFor(req), { dotGroup3: req.body.dotGroup3 }, req.company ? null : req.user?.id)));

export const getVersionFile = catchAsync(async (req, res) => {
  const { row, stream } = await catalogues.versionFile(req.params.id, scopeFor(req));
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Content-Length", row.sizeBytes);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.originalName || "catalogue.pdf")}"`);
  stream.on("error", (err) => res.destroy(err));
  stream.pipe(res);
});
