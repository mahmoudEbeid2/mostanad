-- AlterTable
ALTER TABLE "products" ADD COLUMN     "dosage_form" TEXT,
ADD COLUMN     "prescription_status" TEXT,
ADD COLUMN     "product_type" TEXT,
ADD COLUMN     "route_of_admin" TEXT,
ADD COLUMN     "strength" TEXT;

-- CreateTable
CREATE TABLE "generated_labels" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT,
    "created_by_user_id" TEXT,
    "input_payload" JSONB NOT NULL,
    "product_profile" JSONB,
    "label_data" JSONB NOT NULL,
    "label_provenance" JSONB NOT NULL,
    "schema_version" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reference_label_ids" TEXT[],
    "regulatory_doc_ids" TEXT[],
    "match_tier" TEXT,
    "generation_meta" JSONB,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "autonomy_tier" TEXT NOT NULL DEFAULT 'mandatory',
    "shadow_run_id" TEXT,
    "promoted_to_reference_id" TEXT,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_versions" (
    "id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "label_data" JSONB NOT NULL,
    "change_source" TEXT NOT NULL,
    "changed_by_user_id" TEXT,
    "change_summary" TEXT,
    "diff" JSONB,
    "restored_from" INTEGER,
    "override_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "validation_report_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_reports" (
    "id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "verdicts" JSONB NOT NULL,
    "auditor_verdicts" JSONB,
    "disagreement_count" INTEGER NOT NULL DEFAULT 0,
    "self_consistency" JSONB,
    "coverage_percent" DOUBLE PRECISION,
    "engine_version" TEXT NOT NULL,
    "ruleset_ids" TEXT[],
    "ai_assisted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_chat_messages" (
    "id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "intent" TEXT,
    "tool_calls" JSONB,
    "proposed_patch" JSONB,
    "applied_patch" JSONB,
    "result_version" INTEGER,
    "conflicts" JSONB,
    "user_id" TEXT,
    "token_usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generated_labels_company_id_created_at_idx" ON "generated_labels"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "generated_labels_product_id_idx" ON "generated_labels"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "label_versions_label_id_version_number_key" ON "label_versions"("label_id", "version_number");

-- CreateIndex
CREATE INDEX "validation_reports_label_id_version_number_idx" ON "validation_reports"("label_id", "version_number");

-- CreateIndex
CREATE INDEX "label_chat_messages_label_id_created_at_idx" ON "label_chat_messages"("label_id", "created_at");

-- AddForeignKey
ALTER TABLE "generated_labels" ADD CONSTRAINT "generated_labels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_labels" ADD CONSTRAINT "generated_labels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_versions" ADD CONSTRAINT "label_versions_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "generated_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_reports" ADD CONSTRAINT "validation_reports_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "generated_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_chat_messages" ADD CONSTRAINT "label_chat_messages_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "generated_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

