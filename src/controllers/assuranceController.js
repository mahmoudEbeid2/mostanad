import catchAsync from "../utils/catchAsync.js";
import { prisma } from "../lib/prisma.js";
import * as generatedLabelService from "../services/label/generatedLabelService.js";

export const getDisagreements = catchAsync(async (req, res) => {
  const { disagreements, total } = await generatedLabelService.getDisagreements(req.query);
  res.status(200).json({ status: "success", results: disagreements.length, total, data: { disagreements } });
});

export const resolveDisagreement = catchAsync(async (req, res) => {
  const disagreement = await generatedLabelService.resolveDisagreement(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { disagreement } });
});

export const getGoldenRuns = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const [runs, total] = await Promise.all([
    prisma.goldenEvalRun.findMany({ orderBy: { runAt: "desc" }, skip, take: Number(limit) }),
    prisma.goldenEvalRun.count(),
  ]);
  res.status(200).json({ status: "success", results: runs.length, total, data: { runs } });
});

export const getShadowComparisons = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const [comparisons, total] = await Promise.all([
    prisma.shadowComparison.findMany({ orderBy: { createdAt: "desc" }, skip, take: Number(limit) }),
    prisma.shadowComparison.count(),
  ]);
  res.status(200).json({
    status: "success",
    results: comparisons.length,
    total,
    data: { comparisons },
    ...(total === 0 && { message: "No shadow runs recorded yet — see PROGRESS.md's Phase 8 entry: this session replaced the generator in place rather than running two versions in parallel, so there's no live migration to shadow right now." }),
  });
});

export const getReviewInbox = catchAsync(async (req, res) => {
  const companyId = req.company ? req.company.id : req.query.companyId;
  const { labels, total } = await generatedLabelService.getReviewInbox({ companyId, page: req.query.page, limit: req.query.limit });
  res.status(200).json({ status: "success", results: labels.length, total, data: { labels } });
});
