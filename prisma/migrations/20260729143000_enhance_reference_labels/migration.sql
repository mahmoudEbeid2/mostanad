ALTER TABLE "reference_labels"
ADD COLUMN "full_text" TEXT,
ADD COLUMN "country" TEXT,
ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'upload',
ADD COLUMN "manual_category_name" TEXT,
ADD COLUMN "category_id" TEXT;

ALTER TABLE "reference_labels"
ADD CONSTRAINT "reference_labels_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "categories"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
