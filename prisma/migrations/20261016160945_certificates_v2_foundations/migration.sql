-- Certificates V2 Phase 1 (CERTIFICATES_V2_PLAN.md §6). Additive only.
-- Note: prisma also proposed an unrelated ALTER on regulatory_documents (pre-existing
-- schema.prisma drift outside certificates scope); it was removed from this migration.

-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "company_id" TEXT,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_types" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_templates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "certificate_type_id" TEXT NOT NULL,
    "brand_id" TEXT,
    "country" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'per_product',
    "name" TEXT NOT NULL,
    "active_version_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "source_format" TEXT NOT NULL,
    "source_file_id" TEXT NOT NULL,
    "sanitized_file_id" TEXT,
    "prepared_file_id" TEXT,
    "thumbnail_file_id" TEXT,
    "pages" JSONB,
    "lines" JSONB,
    "font_coverage" JSONB,
    "conversion" JSONB,
    "prepare_report" JSONB,
    "error" TEXT,
    "based_on_version_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_files_company_id_kind_idx" ON "stored_files"("company_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_types_company_id_code_key" ON "certificate_types"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_templates_active_version_id_key" ON "certificate_templates"("active_version_id");

-- CreateIndex
CREATE INDEX "certificate_templates_company_id_certificate_type_id_idx" ON "certificate_templates"("company_id", "certificate_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_number_key" ON "template_versions"("template_id", "version_number");

-- AddForeignKey
ALTER TABLE "certificate_types" ADD CONSTRAINT "certificate_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_certificate_type_id_fkey" FOREIGN KEY ("certificate_type_id") REFERENCES "certificate_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Template slot uniqueness (§6.1): at most one non-archived template per
-- (company, type, brand, country, scope).
CREATE UNIQUE INDEX "certificate_templates_slot_key" ON "certificate_templates" ("company_id", "certificate_type_id", COALESCE("brand_id", ''), COALESCE("country", ''), "scope") WHERE "archived_at" IS NULL;
