-- AlterTable
ALTER TABLE "reference_labels" ADD COLUMN     "active_ingredients" JSONB,
ADD COLUMN     "approval_id" TEXT,
ADD COLUMN     "dosage_form" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "indication_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "is_approved" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin_label_id" TEXT,
ADD COLUMN     "product_type" TEXT,
ADD COLUMN     "quality_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
ADD COLUMN     "route_of_administration" TEXT,
ADD COLUMN     "strength_summary" TEXT,
ADD COLUMN     "superseded_by_id" TEXT,
ADD COLUMN     "target_species" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "label_approvals" (
    "id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "approved_version" INTEGER NOT NULL,
    "label_snapshot" JSONB NOT NULL,
    "validation_report_id" TEXT NOT NULL,
    "approved_by_user_id" TEXT NOT NULL,
    "approver_name" TEXT NOT NULL,
    "approver_role" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_estimated_fields" TEXT[],
    "acknowledged_unverifiable" TEXT[],
    "risk_score_at_approval" INTEGER NOT NULL,
    "autonomy_tier" TEXT NOT NULL,
    "coverage_percent_at_approval" DOUBLE PRECISION,
    "ruleset_snapshot" TEXT[],
    "note" TEXT,
    "second_approver_user_id" TEXT,
    "second_approved_at" TIMESTAMP(3),
    "promoted_reference_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" TEXT,
    "revocation_reason" TEXT,

    CONSTRAINT "label_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_approvals_label_id_approved_version_idx" ON "label_approvals"("label_id", "approved_version");

-- CreateIndex
CREATE INDEX "label_approvals_approved_by_user_id_approved_at_idx" ON "label_approvals"("approved_by_user_id", "approved_at");

-- CreateIndex
CREATE INDEX "reference_labels_country_product_type_idx" ON "reference_labels"("country", "product_type");

-- CreateIndex
CREATE INDEX "reference_labels_fingerprint_company_id_idx" ON "reference_labels"("fingerprint", "company_id");

-- AddForeignKey
ALTER TABLE "label_approvals" ADD CONSTRAINT "label_approvals_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "generated_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "generated_labels" ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false;

