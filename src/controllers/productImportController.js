import catchAsync from "../utils/catchAsync.js";
import * as imports from "../services/catalogues/productImportService.js";

// "منتجات من ملفات" — many products at once. Thin: productImportService holds the rules.
// A company caller always works in its own company; a system user names the company.
const scopeOf = (req) => (req.company ? req.company.id : req.query.companyId || req.body?.companyId || null);
const userIdOf = (req) => req.user?.id || null;

// multipart: files[] (labels, sheets, lists) + text (a pasted list) + companyId (system user) + brandId
export const postImport = catchAsync(async (req, res) => {
  const out = await imports.importProductFiles({ companyId: scopeOf(req), brandId: req.body.brandId || null, files: req.files || [], text: req.body.text || "", userId: userIdOf(req) });
  res.status(202).json({ status: "success", data: out });
});

export const listImports = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { imports: await imports.listImports(scopeOf(req)) } });
});

export const getImport = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await imports.getImport(req.params.id, req.company ? req.company.id : null) });
});

export const patchRow = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { row: await imports.editImportRow(req.params.id, req.params.rowId, req.company ? req.company.id : null, req.body || {}, userIdOf(req)) } });
});

export const skipRow = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await imports.skipImportRow(req.params.id, req.params.rowId, req.company ? req.company.id : null, userIdOf(req)) });
});

export const saveAll = catchAsync(async (req, res) => {
  res.status(201).json({ status: "success", data: await imports.saveAllImported(req.params.id, req.company ? req.company.id : null, userIdOf(req)) });
});
