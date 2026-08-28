import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { promoteToReference } from "./promotionService.js";

/**
 * §12.2's six gates. Throws AppError with the specific gate's status code on
 * the first one that fails — approval is refused, not degraded, on any of them.
 */
export async function assertApprovable(label, report, body, actor) {
  // Gate 1 — the report must be for the label's CURRENT version, not stale.
  if (report.versionNumber !== label.currentVersion) {
    throw new AppError("Validation is stale — re-validate before approving.", 409);
  }

  // Gate 2 — zero FAILs. Final, no override possible for this one.
  if (!report.passed) {
    throw new AppError("Cannot approve a label with validation errors.", 422);
  }

  // Gate 3 — every UNVERIFIABLE verdict explicitly acknowledged by name.
  const unacknowledged = report.verdicts
    .filter((v) => v.status === "UNVERIFIABLE")
    .filter((v) => !body.acknowledgedUnverifiable?.includes(v.path));
  if (unacknowledged.length > 0) {
    throw new AppError(`Unacknowledged UNVERIFIABLE verdicts: ${unacknowledged.map((v) => v.path).join(", ")}`, 422);
  }

  // Gate 4 — every estimated field explicitly signed by name.
  const unsigned = (label.labelData.estimatedFields || []).filter((f) => !body.signedEstimatedFields?.includes(f));
  if (unsigned.length > 0) {
    throw new AppError(`Estimated fields without a signature: ${unsigned.join(", ")}`, 422);
  }

  // Gate 5 — separation of duties.
  if (label.riskScore > 50 && actor.id === label.createdByUserId) {
    throw new AppError("High risk: cannot approve a label you created yourself.", 403);
  }
  if (label.autonomyTier === "dual_review" && !body.secondApproverUserId) {
    throw new AppError("This label requires two independent reviewers.", 422);
  }

  // Gate 6 — every regulatory document behind this validation is itself
  // approved with sufficient coverage. A PASS built on an unreviewed or
  // under-covered document isn't a real PASS.
  if (report.rulesetIds?.length > 0) {
    const rules = await prisma.regulatoryRule.findMany({ where: { id: { in: report.rulesetIds } }, select: { documentId: true } });
    const documentIds = [...new Set(rules.map((r) => r.documentId))];
    const documents = await prisma.regulatoryDocument.findMany({ where: { id: { in: documentIds } } });
    const weak = documents.filter((d) => d.status !== "approved" || (d.coveragePercent ?? 0) < 95);
    if (weak.length > 0) {
      throw new AppError(`Validation relies on weak/unapproved documents: ${weak.map((d) => d.title || d.id).join(", ")}`, 422);
    }
  }
}

/**
 * §12.3 — one transaction: gate check, LabelApproval row, label.status ->
 * approved, promotion to reference. The whole thing succeeds or none of it does.
 */
export const approveLabel = async (labelId, body, actor) => {
  return prisma.$transaction(async (tx) => {
    const label = await tx.generatedLabel.findUnique({ where: { id: labelId } });
    if (!label) throw new AppError("No generated label found with that ID", 404);
    if (actor.companyId && label.companyId !== actor.companyId) throw new AppError("No generated label found with that ID", 404);

    if (Number(body.expectedVersion) !== label.currentVersion) {
      throw new AppError(`Version conflict: expected ${body.expectedVersion}, label is now at ${label.currentVersion}.`, 409);
    }
    if (label.status === "approved") {
      throw new AppError("This version is already approved. Revoke the existing approval first if you need to re-approve.", 409);
    }

    const report = await tx.validationReport.findFirst({ where: { labelId }, orderBy: { createdAt: "desc" } });
    if (!report) throw new AppError("This label has never been validated.", 422);

    await assertApprovable(label, report, body, actor);

    const approval = await tx.labelApproval.create({
      data: {
        labelId,
        approvedVersion: label.currentVersion,
        labelSnapshot: label.labelData,
        validationReportId: report.id,
        approvedByUserId: actor.id,
        approverName: actor.name,
        approverRole: actor.role || null,
        signedEstimatedFields: body.signedEstimatedFields || [],
        acknowledgedUnverifiable: body.acknowledgedUnverifiable || [],
        riskScoreAtApproval: label.riskScore,
        autonomyTier: label.autonomyTier,
        coveragePercentAtApproval: report.coveragePercent,
        rulesetSnapshot: report.rulesetIds,
        note: body.note || null,
        secondApproverUserId: body.secondApproverUserId || null,
        secondApprovedAt: body.secondApproverUserId ? new Date() : null,
      },
    });

    await tx.generatedLabel.update({ where: { id: labelId }, data: { status: "approved" } });

    // §12.1: scope defaults to company — global is a SEPARATE permission
    // (publish_global_reference), enforced by the controller before this
    // service function is ever called, not re-checked here.
    const reference = await promoteToReference(tx, label, approval, body.scope || "company");
    await tx.labelApproval.update({ where: { id: approval.id }, data: { promotedReferenceId: reference.id } });

    return { approval, reference };
  });
};

/**
 * §12.5 — revocation must carry the same weight as approval. Marks the
 * approval revoked, the label revoked, the promoted reference unusable
 * (isApproved: false — never deleted, history stays), and flags every OTHER
 * label whose provenance points at that reference as needing review.
 */
export const revokeApproval = async (approvalId, { reason, userId }, actor) => {
  return prisma.$transaction(async (tx) => {
    const approval = await tx.labelApproval.findUnique({ where: { id: approvalId }, include: { label: true } });
    if (!approval) throw new AppError("No approval found with that ID", 404);
    if (actor.companyId && approval.label.companyId !== actor.companyId) throw new AppError("No approval found with that ID", 404);
    if (approval.revokedAt) throw new AppError("This approval was already revoked.", 400);

    await tx.labelApproval.update({ where: { id: approvalId }, data: { revokedAt: new Date(), revokedByUserId: userId, revocationReason: reason } });
    await tx.generatedLabel.update({ where: { id: approval.labelId }, data: { status: "revoked" } });

    let affectedLabelIds = [];
    if (approval.promotedReferenceId) {
      await tx.referenceLabel.update({ where: { id: approval.promotedReferenceId }, data: { isApproved: false } });

      // Every label whose provenance cites this reference — found via the JSON
      // sourceRef.id path in labelProvenance, since that's where §14.4 records it.
      const candidates = await tx.generatedLabel.findMany({ where: { referenceLabelIds: { has: approval.promotedReferenceId } } });
      affectedLabelIds = candidates.map((c) => c.id);
      if (affectedLabelIds.length > 0) {
        await tx.generatedLabel.updateMany({ where: { id: { in: affectedLabelIds } }, data: { needsReview: true } });
      }
    }

    return { approval, affectedLabelIds };
  });
};
