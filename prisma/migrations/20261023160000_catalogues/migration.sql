-- Certificate AI layers, Phase A6.1 — the product catalogue as a source document (plan.md §15.2, §15.7).
-- Additive only: three new tables and two nullable product columns. No backfill: existing products
-- are untouched until an admin links or applies a catalogue diff (§15.8).
-- AlterTable
ALTER TABLE "products" ADD COLUMN     "catalogue_ref" JSONB,
ADD COLUMN     "field_provenance" JSONB;

-- CreateTable
CREATE TABLE "catalogues" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "brand_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue_versions" (
    "id" TEXT NOT NULL,
    "catalogue_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source_file_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "number_convention" JSONB,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "extraction" JSONB,
    "error" TEXT,
    "uploaded_by_user_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogue_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue_blocks" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'product',
    "page" INTEGER NOT NULL,
    "bbox" JSONB NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "extracted" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogue_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalogues_company_id_manufacturer_key" ON "catalogues"("company_id", "manufacturer");

-- CreateIndex
CREATE INDEX "catalogue_versions_company_id_created_at_idx" ON "catalogue_versions"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "catalogue_versions_catalogue_id_created_at_idx" ON "catalogue_versions"("catalogue_id", "created_at");

-- CreateIndex
CREATE INDEX "catalogue_blocks_version_id_seq_idx" ON "catalogue_blocks"("version_id", "seq");

-- CreateIndex
CREATE INDEX "catalogue_blocks_company_id_idx" ON "catalogue_blocks"("company_id");

-- CreateIndex
CREATE INDEX "catalogue_blocks_product_id_idx" ON "catalogue_blocks"("product_id");

-- AddForeignKey
ALTER TABLE "catalogues" ADD CONSTRAINT "catalogues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogues" ADD CONSTRAINT "catalogues_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_versions" ADD CONSTRAINT "catalogue_versions_catalogue_id_fkey" FOREIGN KEY ("catalogue_id") REFERENCES "catalogues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_blocks" ADD CONSTRAINT "catalogue_blocks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "catalogue_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue_blocks" ADD CONSTRAINT "catalogue_blocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

