import catchAsync from "../../utils/catchAsync.js";
import * as batchService from "../../services/certificates/generation/batchService.js";
import * as certificateService from "../../services/certificates/certificates/certificateService.js";
import * as editService from "../../services/certificates/certificates/editService.js";
import { getMetrics } from "../../services/certificates/maintenance/maintenanceService.js";
import { companyFor, scopeOf, actorId, CERT_HTML_HEADERS } from "./requestScope.js";

// Generation + generated certificates (CERTIFICATES_V2_PLAN.md §10–§12). Thin.

export const generationPlan = catchAsync(async (req, res) => {
  const plan = await batchService.previewPlan(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { plan } });
});

export const generate = catchAsync(async (req, res) => {
  const data = await batchService.startGeneration(req.params.id, scopeOf(req), actorId(req));
  res.status(202).json({ status: "accepted", data });
});

export const getBatch = catchAsync(async (req, res) => {
  const batch = await certificateService.getBatch(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { batch } });
});

export const listCertificates = catchAsync(async (req, res) => {
  const { total, certificates } = await certificateService.listCertificates(companyFor(req), req.validatedQuery || {});
  res.status(200).json({ status: "success", results: certificates.length, total, data: { certificates } });
});

export const getCertificate = catchAsync(async (req, res) => {
  const certificate = await certificateService.getCertificate(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { certificate } });
});

export const getCertificateHtml = catchAsync(async (req, res) => {
  const html = await certificateService.getCertificateHtml(req.params.id, scopeOf(req), req.validatedQuery?.version);
  res.set(CERT_HTML_HEADERS).status(200).send(html);
});

export const getCertificateThumbnail = catchAsync(async (req, res) => {
  const { buffer } = await certificateService.getCertificateThumbnail(req.params.id, scopeOf(req));
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60" }).send(buffer);
});

// ── Phase 5: edit, versions, export, finalize (§11) ─────────────────────────
const sendFile = (res, { row, buffer, fileName }) =>
  res
    .set({
      "Content-Type": row.mimeType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Access-Control-Expose-Headers": "Content-Disposition", // the app runs cross-origin (Vite); it names the download
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    })
    .send(buffer);

export const editValues = catchAsync(async (req, res) => {
  const data = await editService.editValues(req.params.id, scopeOf(req), actorId(req), req.body);
  res.status(200).json({ status: "success", data });
});

export const resetField = catchAsync(async (req, res) => {
  const data = await editService.resetField(req.params.id, scopeOf(req), actorId(req), req.params.key, req.body || {});
  res.status(200).json({ status: "success", data });
});

export const listVersions = catchAsync(async (req, res) => {
  const versions = await editService.listVersions(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", results: versions.length, data: { versions } });
});

export const restoreVersion = catchAsync(async (req, res) => {
  const data = await editService.restoreVersion(req.params.id, scopeOf(req), actorId(req), req.params.n, req.body || {});
  res.status(200).json({ status: "success", data });
});

export const exportPdf = catchAsync(async (req, res) => {
  const data = await editService.startExportPdf(req.params.id, scopeOf(req));
  res.status(202).json({ status: "accepted", data });
});

export const getPdf = catchAsync(async (req, res) => {
  sendFile(res, await editService.getPdf(req.params.id, scopeOf(req), req.validatedQuery?.version));
});

export const finalize = catchAsync(async (req, res) => {
  const certificate = await editService.finalize(req.params.id, scopeOf(req), actorId(req), req.body || {});
  res.status(200).json({ status: "success", data: { certificate } });
});

export const duplicate = catchAsync(async (req, res) => {
  const data = await editService.duplicate(req.params.id, scopeOf(req), actorId(req));
  res.status(201).json({ status: "success", data });
});

export const exportZip = catchAsync(async (req, res) => {
  const data = await editService.startExportZip(req.params.id, scopeOf(req));
  res.status(202).json({ status: "accepted", data });
});

export const getZip = catchAsync(async (req, res) => {
  sendFile(res, await editService.getZip(req.params.id, scopeOf(req)));
});

// ── Phase 6: metrics (§15) ───────────────────────────────────────────────────
export const metrics = catchAsync(async (req, res) => {
  const data = await getMetrics(companyFor(req), req.validatedQuery || {});
  res.status(200).json({ status: "success", data: { metrics: data } });
});
