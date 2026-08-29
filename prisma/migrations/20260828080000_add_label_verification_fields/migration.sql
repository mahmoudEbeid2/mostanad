-- AlterTable
ALTER TABLE "generated_labels" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE "generated_labels" ADD COLUMN "extraction_meta" JSONB;
ALTER TABLE "generated_labels" ADD COLUMN "source_file_ref" TEXT;
