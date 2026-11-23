-- Printable label layouts and label uploads to resize (additive: two new tables).
-- CreateTable
CREATE TABLE "label_layouts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "label_id" TEXT,
    "upload_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'layout',
    "width_mm" DOUBLE PRECISION NOT NULL,
    "height_mm" DOUBLE PRECISION NOT NULL,
    "settings" JSONB NOT NULL,
    "fit" JSONB NOT NULL,
    "pdf_file_id" TEXT,
    "preview_file_id" TEXT,
    "label_version" INTEGER,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_uploads" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT,
    "file_id" TEXT NOT NULL,
    "original_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "label_id" TEXT,
    "task_id" TEXT,
    "error" TEXT,
    "country" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "label_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_layouts_company_id_idx" ON "label_layouts"("company_id");

-- CreateIndex
CREATE INDEX "label_layouts_upload_id_idx" ON "label_layouts"("upload_id");

-- CreateIndex
CREATE UNIQUE INDEX "label_layouts_label_id_version_key" ON "label_layouts"("label_id", "version");

-- CreateIndex
CREATE INDEX "label_uploads_company_id_idx" ON "label_uploads"("company_id");

-- AddForeignKey
ALTER TABLE "label_layouts" ADD CONSTRAINT "label_layouts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_layouts" ADD CONSTRAINT "label_layouts_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "generated_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_layouts" ADD CONSTRAINT "label_layouts_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "label_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_uploads" ADD CONSTRAINT "label_uploads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

