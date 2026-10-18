-- Certificates V2 Phase 2 (CERTIFICATES_V2_PLAN.md §6.1 TemplateField, D10). Additive only.

-- CreateTable
CREATE TABLE "template_fields" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 1,
    "line_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    "sample_value" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "format" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "align" TEXT NOT NULL DEFAULT 'left',
    "box" JSONB,
    "limits" JSONB,
    "letter_spacing" DOUBLE PRECISION,
    "font_class" TEXT,
    "scale" DOUBLE PRECISION,
    "group_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_fields_version_id_key_key" ON "template_fields"("version_id", "key");

-- AddForeignKey
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

