-- A company's own fonts for its certificate templates (.ttf/.otf/.woff2). Additive: a new table.
-- CreateTable
CREATE TABLE "company_fonts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 400,
    "style" TEXT NOT NULL DEFAULT 'normal',
    "format" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "coverage" JSONB NOT NULL,
    "original_name" TEXT,
    "uploaded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_fonts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_fonts_company_id_family_weight_style_key" ON "company_fonts"("company_id", "family", "weight", "style");

-- AddForeignKey
ALTER TABLE "company_fonts" ADD CONSTRAINT "company_fonts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

