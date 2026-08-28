-- Phase 3: rename eda_requirements -> regulatory_documents (table rename only —
-- no column dropped, renamed, or narrowed; extractedText/extractedData/country/
-- company_id/id/created_at/updated_at are untouched), add nullable/defaulted
-- columns per §5.6, and create the new regulatory_rules table per §5.7.
-- Hand-written (not from `prisma migrate diff`) because the diff tool matches
-- models by @@map name and would otherwise generate DROP TABLE eda_requirements
-- + CREATE TABLE regulatory_documents, which is destructive.

ALTER TABLE "eda_requirements" RENAME TO "regulatory_documents";
ALTER TABLE "regulatory_documents" RENAME CONSTRAINT "eda_requirements_pkey" TO "regulatory_documents_pkey";
ALTER TABLE "regulatory_documents" RENAME CONSTRAINT "eda_requirements_company_id_fkey" TO "regulatory_documents_company_id_fkey";

ALTER TABLE "regulatory_documents"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "authority" TEXT,
  ADD COLUMN "product_scope" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "source_is_official" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "document_version" TEXT,
  ADD COLUMN "effective_date" TIMESTAMP(3),
  ADD COLUMN "superseded_by_id" TEXT,
  ADD COLUMN "retrieved_at" TIMESTAMP(3),
  ADD COLUMN "document_hash" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending_review',
  ADD COLUMN "reviewed_by_user_id" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "clause_total" INTEGER,
  ADD COLUMN "clause_covered" INTEGER,
  ADD COLUMN "coverage_percent" DOUBLE PRECISION,
  ADD COLUMN "uncovered_clauses" JSONB,
  ADD COLUMN "coverage_audited_at" TIMESTAMP(3);

CREATE INDEX "regulatory_documents_country_authority_status_idx" ON "regulatory_documents"("country", "authority", "status");

-- CreateTable
CREATE TABLE "regulatory_rules" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "target_path" TEXT,
    "applies_when" JSONB,
    "constraint" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "citation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "auto_fixable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulatory_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "regulatory_rules_ruleType_severity_status_idx" ON "regulatory_rules"("ruleType", "severity", "status");
CREATE UNIQUE INDEX "regulatory_rules_document_id_ruleKey_key" ON "regulatory_rules"("document_id", "ruleKey");

ALTER TABLE "regulatory_rules" ADD CONSTRAINT "regulatory_rules_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "regulatory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
