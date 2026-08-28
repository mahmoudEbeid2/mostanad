import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { prisma } from "../lib/prisma.js";
import { approveLabel, revokeApproval } from "../services/label/approval/approvalService.js";

const scopeFor = (req) => (req.company ? req.company.id : req.query.companyId);

// Invariant #13: "global" is a SEPARATE permission from ordinary approval —
// a company tenant is never granted this at all (see authMiddleware's
// companyAllowedModules — "global" is deliberately absent from it), and a
// system user needs the specific publish_global_reference grant, not just
// approve_labels.
function assertCanPublishGlobal(req) {
  if (req.company) throw new AppError("Company accounts cannot promote a reference globally.", 403);
  const permissions = req.user?.role?.permissions?.map((rp) => rp.permission.slug) || [];
  if (!permissions.includes("publish_global_reference")) {
    throw new AppError("Promoting a reference globally requires the publish_global_reference permission.", 403);
  }
}

export const postApprove = catchAsync(async (req, res) => {
  if (req.body.scope === "global") assertCanPublishGlobal(req);

  const actor = {
    id: req.user?.id,
    name: req.user?.name,
    role: req.company ? "company" : req.user?.role?.name,
    companyId: scopeFor(req),
  };
  const result = await approveLabel(req.params.id, req.body, actor);
  res.status(201).json({ status: "success", data: result });
});

export const getApprovals = catchAsync(async (req, res) => {
  const companyId = scopeFor(req);
  if (companyId) {
    const label = await prisma.generatedLabel.findUnique({ where: { id: req.params.id } });
    if (!label || label.companyId !== companyId) throw new AppError("No generated label found with that ID", 404);
  }
  const approvals = await prisma.labelApproval.findMany({ where: { labelId: req.params.id }, orderBy: { approvedAt: "desc" } });
  res.status(200).json({ status: "success", results: approvals.length, data: { approvals } });
});

export const postRevoke = catchAsync(async (req, res) => {
  const actor = { companyId: scopeFor(req) };
  const result = await revokeApproval(req.params.approvalId, { reason: req.body.reason, userId: req.user?.id }, actor);
  res.status(200).json({ status: "success", data: result });
});
