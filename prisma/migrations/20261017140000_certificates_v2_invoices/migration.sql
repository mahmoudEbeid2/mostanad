-- Certificates V2 Phase 3 (CERTIFICATES_V2_PLAN.md §6.1 Invoice, InvoiceItem). Additive only.

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "brand_id" TEXT,
    "country" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "source_file_id" TEXT NOT NULL,
    "header" JSONB,
    "header_extracted" JSONB,
    "extraction" JSONB,
    "error" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "uploaded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "data_extracted" JSONB NOT NULL,
    "product_id" TEXT,
    "match_status" TEXT NOT NULL DEFAULT 'needs_match',
    "match_method" TEXT,
    "match_candidates" JSONB,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_company_id_created_at_idx" ON "invoices"("company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_invoice_id_line_no_key" ON "invoice_items"("invoice_id", "line_no");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

