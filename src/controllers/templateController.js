import catchAsync from "../utils/catchAsync.js";
import {
  createTemplate as createTemplateService,
  getAllTemplates as getAllTemplatesService,
  getTemplateById as getTemplateByIdService,
  updateTemplate as updateTemplateService,
  deleteTemplate as deleteTemplateService,
} from "../services/templateService.js";
import AppError from "../utils/appError.js";
import { scopeFor, assertCompanyAccess } from "../utils/tenantScope.js";

// 1. CREATE TEMPLATE
export const createTemplate = catchAsync(async (req, res, next) => {
  const companyId = req.company ? req.company.id : req.params.companyId || req.body.companyId;
  assertCompanyAccess(req, req.params.companyId || companyId);
  const template = await createTemplateService(companyId, req.body);
  res.status(201).json({ status: "success", data: { template } });
});

// 2. GET ALL TEMPLATES
export const getAllTemplates = catchAsync(async (req, res, next) => {
  if (req.params.companyId) assertCompanyAccess(req, req.params.companyId);
  const companyId = req.params.companyId || scopeFor(req);
  const { companyId: _ignored, ...query } = req.query;
  const { meta, templates } = await getAllTemplatesService(companyId, query);
  res.status(200).json({ status: "success", meta, data: { templates } });
});

// 3. GET TEMPLATE BY ID
export const getTemplateById = catchAsync(async (req, res, next) => {
  const template = await getTemplateByIdService(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({ status: "success", data: { template } });
});

// 4. UPDATE TEMPLATE
export const updateTemplate = catchAsync(async (req, res, next) => {
  const template = await updateTemplateService(req.params.id, req.body, { companyId: scopeFor(req) });
  res.status(200).json({ status: "success", data: { template } });
});

// 5. DELETE TEMPLATE
export const deleteTemplate = catchAsync(async (req, res, next) => {
  await deleteTemplateService(req.params.id, { companyId: scopeFor(req) });
  res.status(204).json({ status: "success", data: null });
});

// 6. GENERATE TEMPLATE VIA AI — disabled (Certificates V2 Phase 0).
// The V1 AI pipeline produced unverifiable HTML and shelled out with the
// uploaded filename. V2 replaces it with POST /certificate-templates.
export const generateTemplateViaAI = catchAsync(async (req, res, next) => {
  return next(
    new AppError("AI template generation is disabled. Upload the design via POST /certificate-templates instead.", 410)
  );
});
