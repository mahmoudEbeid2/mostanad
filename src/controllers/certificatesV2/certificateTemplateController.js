import catchAsync from "../../utils/catchAsync.js";
import * as templateService from "../../services/certificates/templates/templateService.js";
import * as fieldService from "../../services/certificates/templates/fieldService.js";
import * as prepareService from "../../services/certificates/templates/prepareService.js";
import * as assistService from "../../services/certificates/templates/assistService.js";
import { getSourceCatalogue } from "../../services/certificates/templates/sourceCatalogue.js";
import { companySourceCatalogue } from "../../services/certificates/dictionary/dataDictionary.js";
import { searchProducts } from "../../services/certificates/matching/productSearch.js";
import { companyFor, scopeOf, actorId, sendCertHtml } from "./requestScope.js";

export const createTemplate = catchAsync(async (req, res) => {
  const data = await templateService.createTemplateFromUpload({
    companyId: companyFor(req),
    userId: actorId(req),
    file: req.file,
    settings: req.body,
  });
  res.status(202).json({ status: "accepted", data });
});

export const listTemplates = catchAsync(async (req, res) => {
  const { total, templates } = await templateService.listTemplates(companyFor(req), {
    ...req.query,
    includeArchived: req.query.includeArchived === "true",
  });
  res.status(200).json({ status: "success", results: templates.length, total, data: { templates } });
});

export const getTemplate = catchAsync(async (req, res) => {
  const template = await templateService.getTemplate(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { template } });
});

export const updateTemplate = catchAsync(async (req, res) => {
  const template = await templateService.updateTemplateSettings(req.params.id, scopeOf(req), req.body);
  res.status(200).json({ status: "success", data: { template } });
});

export const uploadVersion = catchAsync(async (req, res) => {
  const data = await templateService.uploadNewVersion({
    templateId: req.params.id,
    companyId: scopeOf(req),
    userId: actorId(req),
    file: req.file,
  });
  res.status(202).json({ status: "accepted", data });
});

export const archiveTemplate = catchAsync(async (req, res) => {
  const template = await templateService.archiveTemplate(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { template } });
});

export const getVersion = catchAsync(async (req, res) => {
  const version = await templateService.getVersionDetail(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { version } });
});

export const getVersionHtml = catchAsync(async (req, res) => {
  const variant = req.validatedQuery?.variant;
  const html =
    variant === "sample"
      ? await prepareService.renderSample(req.params.id, scopeOf(req))
      : (await templateService.getVersionHtml(req.params.id, scopeOf(req), variant)).html;
  sendCertHtml(res, html);
});

// ── Phase 2: fields, prepare, activate ───────────────────────────────────────
// With a company (a company caller, or ?companyId= for a system user) the
// product paths include what that company's products actually hold inside
// their JSON columns (plan.md §3.2); without one, the static catalogue.
export const getFieldSources = catchAsync(async (req, res) => {
  const companyId = req.company?.id || req.validatedQuery?.companyId;
  res.status(200).json({ status: "success", data: companyId ? await companySourceCatalogue(companyId) : getSourceCatalogue() });
});

export const putFields = catchAsync(async (req, res) => {
  const data = await fieldService.replaceFields(req.params.id, scopeOf(req), req.body.fields, req.body.groups);
  res.status(200).json({ status: "success", data });
});

// §7.8: a new draft version of the same design with a vector background, fields copied
export const enableGroups = catchAsync(async (req, res) => {
  const data = await templateService.enableGroups(req.params.id, scopeOf(req), actorId(req));
  res.status(202).json({ status: "accepted", data });
});

export const confirmFields = catchAsync(async (req, res) => {
  const fields = await fieldService.confirmFields(req.params.id, scopeOf(req), req.body.keys);
  res.status(200).json({ status: "success", data: { fields } });
});

export const suggestFields = catchAsync(async (req, res) => {
  const data = await assistService.suggestFields(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data });
});

export const prepareVersion = catchAsync(async (req, res) => {
  const data = await prepareService.startPrepare(req.params.id, scopeOf(req));
  res.status(202).json({ status: "accepted", data });
});

export const getPrepareDiff = catchAsync(async (req, res) => {
  const { buffer } = await prepareService.getDiffImage(req.params.id, scopeOf(req), req.validatedQuery?.page);
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" }).send(buffer);
});

export const previewVersion = catchAsync(async (req, res) => {
  const data = await prepareService.preview(req.params.id, scopeOf(req), req.body);
  res.status(200).json({ status: "success", data });
});

export const activateVersion = catchAsync(async (req, res) => {
  const data = await prepareService.activateVersion(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data });
});

export const newVersion = catchAsync(async (req, res) => {
  const data = await prepareService.cloneVersion(req.params.id, scopeOf(req), actorId(req));
  res.status(201).json({ status: "success", data });
});

export const getThumbnail = catchAsync(async (req, res) => {
  const { buffer } = await templateService.getThumbnail(req.params.id, scopeOf(req));
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" }).send(buffer);
});

export const productSearch = catchAsync(async (req, res) => {
  const products = await searchProducts(companyFor(req), req.validatedQuery || {});
  res.status(200).json({ status: "success", results: products.length, data: { products } });
});
