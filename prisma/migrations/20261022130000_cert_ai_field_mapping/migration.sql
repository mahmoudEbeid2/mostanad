-- Certificate AI layers, Phase A1 — template field mapping (plan.md §4, §5).
-- Additive only: new columns have defaults or are nullable; one new table.
ALTER TABLE "template_fields" ADD COLUMN "mapping_origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "template_fields" ADD COLUMN "mapping_suggestion_id" TEXT;
ALTER TABLE "template_fields" ADD COLUMN "mapping_confirmed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "template_fields" ADD COLUMN "data_category" TEXT;

CREATE TABLE "field_mapping_memory" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "label_norm" TEXT NOT NULL,
    "certificate_type_id" TEXT,
    "source" JSONB NOT NULL,
    "format" JSONB,
    "category" TEXT,
    "times_used" INTEGER NOT NULL DEFAULT 1,
    "last_used_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "field_mapping_memory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "field_mapping_memory_company_id_label_norm_certificate_type_key" ON "field_mapping_memory"("company_id", "label_norm", "certificate_type_id");
ALTER TABLE "field_mapping_memory" ADD CONSTRAINT "field_mapping_memory_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
