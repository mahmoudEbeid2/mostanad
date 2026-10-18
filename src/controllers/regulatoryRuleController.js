import catchAsync from "../utils/catchAsync.js";
import * as regulatoryDocumentService from "../services/label/regulatory/regulatoryDocumentService.js";
import { getApprovedRulesForCountry } from "../services/label/regulatory/regulatoryDocumentService.js";
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

  // Reuses the same tenant-scoped, non-"rejected" query the real validation
  // path uses (getApprovedRulesForCountry) — a preview that used a different
  // filter (the old hardcoded status:"approved" here missed every rule
  // created under the ingestion overhaul's "active" default) would show rules
  // that don't actually run, or hide ones that do.
  const scopedRules = await getApprovedRulesForCountry(label.country, { companyId: label.companyId });

  const verdicts = runRules(label.labelData, scopedRules);
  res.status(200).json({ status: "success", data: { verdicts, ruleCount: scopedRules.length } });
});
