-- Ingestion overhaul (§0-§7): additive only, every column nullable or defaulted.
-- Hand-written (not `prisma migrate dev`) because this dev database has a
-- pre-existing, unrelated drift entry (_prisma_migrations records
-- "20260726224901_sync_all_missing_fields" as applied, but no such migration
-- folder exists in this repo — predates this change, not caused by it).
-- `prisma migrate dev`'s shadow-database diff refuses to proceed without a
-- full `prisma migrate reset` (destroys all dev data) because of that
-- pre-existing entry, so this file is applied directly via
-- `prisma db execute` + `prisma migrate resolve --applied`, leaving the drift
-- exactly as it was found rather than papering over it with a reset.

ALTER TABLE "regulatory_documents"
  ADD COLUMN "activation_mode" TEXT NOT NULL DEFAULT 'full',
  ADD COLUMN "label_field_schema" JSONB;

-- Per-rule manual approval is removed (decision 1): new rules are created
-- "active" directly. Existing "pending_review" rows are left as-is (no
-- backfill needed) because getApprovedRulesForCountry now treats any
-- non-"rejected" status as usable — see regulatoryDocumentService.js.
ALTER TABLE "regulatory_rules"
  ALTER COLUMN "status" SET DEFAULT 'active',
  ADD COLUMN "confidence" DOUBLE PRECISION DEFAULT 1,
  ADD COLUMN "auto_downgraded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "downgrade_reason" TEXT,
  ADD COLUMN "downgraded_at" TIMESTAMP(3),
  ADD COLUMN "observed_failure_rate" DOUBLE PRECISION,
  ADD COLUMN "observed_sample_size" INTEGER;

-- CreateTable
CREATE TABLE "rule_evaluation_outcomes" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "label_id" TEXT,
    "discriminant_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_evaluation_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rule_evaluation_outcomes_rule_id_discriminant_key_idx" ON "rule_evaluation_outcomes"("rule_id", "discriminant_key");

ALTER TABLE "rule_evaluation_outcomes" ADD CONSTRAINT "rule_evaluation_outcomes_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "regulatory_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
