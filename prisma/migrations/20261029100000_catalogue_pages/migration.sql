-- Choose catalogue pages (C1): only the pages a person keeps are sent to the AI.
-- Additive only: two nullable columns, one new table. No backfill: a version
-- uploaded before this has no page rows; GET …/pages reads them on demand.

-- AlterTable
ALTER TABLE "ai_calls" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "catalogue_versions" ADD COLUMN     "page_selection" JSONB;

-- CreateTable
CREATE TABLE "catalogue_pages" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text_length" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalogue_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalogue_pages_company_id_idx" ON "catalogue_pages"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalogue_pages_version_id_number_key" ON "catalogue_pages"("version_id", "number");

-- AddForeignKey
ALTER TABLE "catalogue_pages" ADD CONSTRAINT "catalogue_pages_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "catalogue_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

