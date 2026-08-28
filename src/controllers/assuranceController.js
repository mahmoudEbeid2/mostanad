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

// GET /assurance/shadow — Phase 8's ShadowComparison model doesn't exist yet.
// Returns an empty, honestly-labeled result rather than 404ing the whole
// assurance surface for a feature that's simply not built yet.
export const getShadowComparisons = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", results: 0, total: 0, data: { comparisons: [] }, message: "Shadow mode is not implemented yet (Phase 8)." });
});

export const getReviewInbox = catchAsync(async (req, res) => {
  const companyId = req.company ? req.company.id : req.query.companyId;
  const { labels, total } = await generatedLabelService.getReviewInbox({ companyId, page: req.query.page, limit: req.query.limit });
  res.status(200).json({ status: "success", results: labels.length, total, data: { labels } });
});
