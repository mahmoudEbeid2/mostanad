import * as generatedLabelService from "../services/label/generatedLabelService.js";
import catchAsync from "../utils/catchAsync.js";

// A company caller only ever sees its own labels. A system user may narrow by
// ?companyId=; omitting it lists across all tenants (internal/admin visibility).
const scopeFor = (req) => (req.company ? req.company.id : req.query.companyId);

export const getAllLabels = catchAsync(async (req, res) => {
  const { page, limit, productId } = req.query;
  const { labels, total } = await generatedLabelService.getAll({
    page,
    limit,
    productId,
    companyId: scopeFor(req),
  });

  res.status(200).json({
    status: "success",
    results: labels.length,
    total,
    data: { labels },
  });
});

export const getLabel = catchAsync(async (req, res) => {
  const result = await generatedLabelService.getById(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({
    status: "success",
    data: result,
  });
});

export const getLabelVersions = catchAsync(async (req, res) => {
  const versions = await generatedLabelService.getVersions(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({
    status: "success",
    results: versions.length,
    data: { versions },
  });
});

export const postValidate = catchAsync(async (req, res) => {
  const report = await generatedLabelService.runValidation(req.params.id, { companyId: scopeFor(req) });
  res.status(201).json({
    status: "success",
    data: { report },
  });
});

export const getValidation = catchAsync(async (req, res) => {
  const report = await generatedLabelService.getLatestValidation(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({
    status: "success",
    data: { report },
  });
});

export const postAudit = catchAsync(async (req, res) => {
  const result = await generatedLabelService.runAudit(req.params.id, { companyId: scopeFor(req) });
  res.status(201).json({ status: "success", data: result });
});

export const postChat = catchAsync(async (req, res) => {
  const { message, expectedVersion, overrideAcknowledged } = req.body;
  const result = await generatedLabelService.chat(req.params.id, {
    message,
    expectedVersion,
    overrideAcknowledged,
    userId: req.user ? req.user.id : null,
    companyId: scopeFor(req),
  });
  res.status(result.status === "conflict" ? 409 : 200).json({ status: "success", data: result });
});

export const getChat = catchAsync(async (req, res) => {
  const messages = await generatedLabelService.getChatHistory(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({ status: "success", results: messages.length, data: { messages } });
});

export const patchLabel = catchAsync(async (req, res) => {
  const { changes, rationale, expectedVersion } = req.body;
  const result = await generatedLabelService.applyDirectPatch(req.params.id, {
    changes,
    rationale,
    expectedVersion,
    userId: req.user ? req.user.id : null,
    companyId: scopeFor(req),
  });
  res.status(result.status === "conflict" ? 409 : 200).json({ status: "success", data: result });
});

export const getVersion = catchAsync(async (req, res) => {
  const version = await generatedLabelService.getVersion(req.params.id, req.params.n, { companyId: scopeFor(req) });
  res.status(200).json({ status: "success", data: { version } });
});

export const postRestore = catchAsync(async (req, res) => {
  const result = await generatedLabelService.restoreVersion(req.params.id, req.params.n, { companyId: scopeFor(req) });
  res.status(201).json({ status: "success", data: result });
});

export const getVersionsDiff = catchAsync(async (req, res) => {
  const diff = await generatedLabelService.diffVersions(req.params.id, req.params.a, req.params.b, { companyId: scopeFor(req) });
  res.status(200).json({ status: "success", data: { diff } });
});
