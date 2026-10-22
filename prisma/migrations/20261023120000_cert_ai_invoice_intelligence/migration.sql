-- Certificate AI layers, Phase A2 — invoice intelligence (plan.md §4, §6).
-- Additive only: one nullable column, one new table.
ALTER TABLE "invoice_items" ADD COLUMN "text_span" JSONB;

CREATE TABLE "certificate_data_needs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "plan_key" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "invoice_item_id" TEXT,
    "product_id" TEXT,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "required" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "value" TEXT,
    "provenance" JSONB,
    "basis" TEXT NOT NULL,
    "ai_asked_basis" TEXT,
    "suggestion_id" TEXT,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_data_needs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "certificate_data_needs_company_id_status_idx" ON "certificate_data_needs"("company_id", "status");
CREATE UNIQUE INDEX "certificate_data_needs_invoice_id_plan_key_field_key_key" ON "certificate_data_needs"("invoice_id", "plan_key", "field_key");
ALTER TABLE "certificate_data_needs" ADD CONSTRAINT "certificate_data_needs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
