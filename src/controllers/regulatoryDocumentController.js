import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";
import * as regulatoryDocumentService from "../services/label/regulatory/regulatoryDocumentService.js";

const edaRequirementQueue = new Queue("edaRequirementQueue", { connection: getRedisConfig() });

// Step 1 of §7.4's journey. Reuses edaRequirementQueue/edaRequirementWorker.js —
// same extraction worker /eda-requirements has always used, just with the fuller
// field set §7.4/§15 call for.
export const uploadDocument = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError("Please upload a PDF or DOCX file.", 400));

  const { country = "Egypt", title, authority, productScope, sourceUrl, documentVersion, companyId: bodyCompanyId, review } = req.body;
  const companyId = req.company ? req.company.id : (bodyCompanyId || null);

  const task = await prisma.backgroundTask.create({
    data: { type: "regulatory_document_extraction", status: "pending", companyId },
  });

  await edaRequirementQueue.add(
    "processEdaRequirement",
    {
      country,
      title: title || null,
      authority: authority || null,
      productScope: productScope ? (Array.isArray(productScope) ? productScope : String(productScope).split(",").map((s) => s.trim())) : [],
      sourceUrl: sourceUrl || null,
      documentVersion: documentVersion || null,
      fileBufferBase64: req.file.buffer.toString("base64"),
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      companyId,
      // from the label review's "Add rules for <country>": stop before activation, a person approves
      review: review === true || review === "true",
    },
    { jobId: task.id }
  );

  res.status(202).json({ status: "success", message: "Document uploaded and queued for extraction", data: { taskId: task.id, documentId: null } });
});

export const getDocuments = catchAsync(async (req, res) => {
  const { documents, total } = await regulatoryDocumentService.getDocuments(req.query);
  res.status(200).json({ status: "success", results: documents.length, total, data: { documents } });
});

export const getDocument = catchAsync(async (req, res) => {
  const document = await regulatoryDocumentService.getDocumentById(req.params.id);
  res.status(200).json({ status: "success", data: { document } });
});

export const compileRules = catchAsync(async (req, res) => {
  const { created, rejected } = await regulatoryDocumentService.compileRulesFor(req.params.id);
  res.status(201).json({
    status: "success",
    message: `${created.length} rule(s) compiled and pending review, ${rejected.length} rejected.`,
    data: { rules: created, rejected },
  });
});

export const auditCoverage = catchAsync(async (req, res) => {
  const document = await regulatoryDocumentService.auditCoverageFor(req.params.id);
  res.status(200).json({ status: "success", data: { document } });
});

export const approveDocument = catchAsync(async (req, res) => {
  const document = await regulatoryDocumentService.approveDocument(req.params.id, req.user?.id);
  res.status(200).json({ status: "success", data: { document } });
});

export const markClauseNonNormative = catchAsync(async (req, res) => {
  const document = await regulatoryDocumentService.markClauseNonNormative(req.params.id, req.body.reference);
  res.status(200).json({ status: "success", data: { document } });
});

// GET /regulatory-documents/coverage?country=SA — where that country's rules stand (label review)
export const getCountryRules = catchAsync(async (req, res, next) => {
  if (!req.query.country) return next(new AppError("Name the country", 400));
  const companyId = req.company ? req.company.id : req.query.companyId || undefined;
  res.status(200).json({ status: "success", data: await regulatoryDocumentService.rulesForCountry(req.query.country, { companyId }) });
});

// POST /regulatory-documents/copy { fromCountry, toCountry } — a starting point, not in force until approved
export const copyRules = catchAsync(async (req, res, next) => {
  const { fromCountry, toCountry } = req.body || {};
  if (!fromCountry || !toCountry) return next(new AppError("Name the country to copy from and the one to copy to", 400));
  const companyId = req.company ? req.company.id : req.body.companyId || null;
  res.status(201).json({ status: "success", data: await regulatoryDocumentService.copyRulesToCountry({ fromCountry, toCountry, companyId }) });
});

// POST /regulatory-documents/:id/resume — a document whose automatic chain stopped: compile + audit in the background
export const resumeDocument = catchAsync(async (req, res, next) => {
  const doc = await prisma.regulatoryDocument.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, companyId: true } });
  if (!doc || (req.company && doc.companyId && doc.companyId !== req.company.id)) return next(new AppError("No regulatory document found with that ID", 404));
  if (doc.status === "approved") return next(new AppError("This document is already in force.", 409));
  const task = await prisma.backgroundTask.create({ data: { type: "regulatory_document_extraction", status: "pending", companyId: doc.companyId } });
  await edaRequirementQueue.add("resumeEdaRequirement", { resumeDocumentId: doc.id, companyId: doc.companyId }, { jobId: task.id });
  res.status(202).json({ status: "success", data: { taskId: task.id, documentId: doc.id } });
});
