import catchAsync from "../utils/catchAsync.js";
import {
  createTemplate as createTemplateService,
  getAllTemplates as getAllTemplatesService,
  getTemplateById as getTemplateByIdService,
  updateTemplate as updateTemplateService,
  deleteTemplate as deleteTemplateService,
} from "../services/templateService.js";

// 1. CREATE TEMPLATE
export const createTemplate = catchAsync(async (req, res, next) => {
  const template = await createTemplateService(req.params.companyId, req.body);
  res.status(201).json({ status: "success", data: { template } });
});

// 2. GET ALL TEMPLATES
export const getAllTemplates = catchAsync(async (req, res, next) => {
  const { meta, templates } = await getAllTemplatesService(req.params.companyId, req.query);
  res.status(200).json({ status: "success", meta, data: { templates } });
});

// 3. GET TEMPLATE BY ID
export const getTemplateById = catchAsync(async (req, res, next) => {
  const template = await getTemplateByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { template } });
});

// 4. UPDATE TEMPLATE
export const updateTemplate = catchAsync(async (req, res, next) => {
  const template = await updateTemplateService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { template } });
});

// 5. DELETE TEMPLATE
export const deleteTemplate = catchAsync(async (req, res, next) => {
  await deleteTemplateService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
