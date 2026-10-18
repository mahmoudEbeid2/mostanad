-- Certificates V2 Phase 4 (CERTIFICATES_V2_PLAN.md §6.1, §10, §20 I15/I18). Additive only.
-- DropForeignKey

-- DropTable

-- CreateTable
CREATE TABLE "certificate_batches" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "plan" JSONB NOT NULL,
    "counts" JSONB,
    "zip_file_id" TEXT,
    "started_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "certificate_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "certificate_type_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "product_id" TEXT,
    "plan_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "flag_count" INTEGER NOT NULL DEFAULT 0,
    "search" TEXT,
    "error" TEXT,
    "finalized_at" TIMESTAMP(3),
    "finalized_by_user_id" TEXT,
    "final_pdf_file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_items" (
    "certificate_id" TEXT NOT NULL,
    "invoice_item_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "certificate_items_pkey" PRIMARY KEY ("certificate_id","invoice_item_id")
);

-- CreateTable
CREATE TABLE "certificate_versions" (
    "id" TEXT NOT NULL,
    "certificate_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "html_file_id" TEXT,
    "pdf_file_id" TEXT,
    "thumbnail_file_id" TEXT,
    "change_source" TEXT NOT NULL,
    "changed_by_user_id" TEXT,
    "change_summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "certificate_batches_company_id_invoice_id_idx" ON "certificate_batches"("company_id", "invoice_id");

-- CreateIndex
CREATE INDEX "certificates_company_id_invoice_id_idx" ON "certificates"("company_id", "invoice_id");

-- CreateIndex
CREATE INDEX "certificates_company_id_status_idx" ON "certificates"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_batch_id_plan_key_key" ON "certificates"("batch_id", "plan_key");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_versions_certificate_id_version_number_key" ON "certificate_versions"("certificate_id", "version_number");

-- AddForeignKey
ALTER TABLE "certificate_batches" ADD CONSTRAINT "certificate_batches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_batches" ADD CONSTRAINT "certificate_batches_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "certificate_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_certificate_type_id_fkey" FOREIGN KEY ("certificate_type_id") REFERENCES "certificate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_items" ADD CONSTRAINT "certificate_items_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_items" ADD CONSTRAINT "certificate_items_invoice_item_id_fkey" FOREIGN KEY ("invoice_item_id") REFERENCES "invoice_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_versions" ADD CONSTRAINT "certificate_versions_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

