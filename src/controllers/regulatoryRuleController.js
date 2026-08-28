import catchAsync from "../utils/catchAsync.js";
import * as regulatoryDocumentService from "../services/label/regulatory/regulatoryDocumentService.js";
import { run as runRules } from "../services/label/validation/ruleValidator.js";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";

export const getRules = catchAsync(async (req, res) => {
  const { rules, total } = await regulatoryDocumentService.getRules(req.query);
  res.status(200).json({ status: "success", results: rules.length, total, data: { rules } });
});

export const updateRule = catchAsync(async (req, res) => {
  const rule = await regulatoryDocumentService.updateRule(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { rule } });
});

export const approveRule = catchAsync(async (req, res) => {
  const rule = await regulatoryDocumentService.approveRule(req.params.id);
  res.status(200).json({ status: "success", data: { rule } });
});

export const rejectRule = catchAsync(async (req, res) => {
  const rule = await regulatoryDocumentService.rejectRule(req.params.id);
  res.status(200).json({ status: "success", data: { rule } });
});

// "Which rules would fire against this label, and what would they say?" — a
// dry run against a label's CURRENT labelData using whatever approved rules
// exist for its country. Never writes anything.
export const previewRules = catchAsync(async (req, res, next) => {
  const { labelId } = req.body;
  if (!labelId) return next(new AppError("Please provide labelId", 400));

  const label = await prisma.generatedLabel.findUnique({ where: { id: labelId } });
  if (!label) return next(new AppError("No generated label found with that ID", 404));

  const { rules } = await regulatoryDocumentService.getRules({ status: "approved", limit: 1000 });

  // Country-scoping happens via the owning document, not the rule itself.
  const documents = await prisma.regulatoryDocument.findMany({
    where: { country: label.country, status: "approved" },
    select: { id: true },
  });
  const documentIds = new Set(documents.map((d) => d.id));
  const scopedRules = rules.filter((r) => documentIds.has(r.documentId));

  const verdicts = runRules(label.labelData, scopedRules);
  res.status(200).json({ status: "success", data: { verdicts, ruleCount: scopedRules.length } });
});
