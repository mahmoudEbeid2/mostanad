-- Fill automatically, item 4 (owner 2026-10-26), additive only: per-batch lab results
-- (reused for the same company + product + batch number) and supplier COA uploads.
-- CreateTable
CREATE TABLE "batch_results" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "batch_no" TEXT NOT NULL,
    "batch_norm" TEXT NOT NULL,
    "label_norm" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "confirmed_by_user_id" TEXT,
    "source_invoice_id" TEXT,
    "source_invoice_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_coas" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "pages" INTEGER NOT NULL DEFAULT 0,
    "text_source" TEXT,
    "result" JSONB,
    "error" TEXT,
    "task_id" TEXT,
    "uploaded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_coas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_results_company_id_batch_norm_idx" ON "batch_results"("company_id", "batch_norm");

-- CreateIndex
CREATE UNIQUE INDEX "batch_results_company_id_product_id_batch_norm_label_norm_key" ON "batch_results"("company_id", "product_id", "batch_norm", "label_norm");

-- CreateIndex
CREATE INDEX "supplier_coas_company_id_invoice_id_idx" ON "supplier_coas"("company_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "batch_results" ADD CONSTRAINT "batch_results_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_results" ADD CONSTRAINT "batch_results_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_coas" ADD CONSTRAINT "supplier_coas_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_coas" ADD CONSTRAINT "supplier_coas_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

