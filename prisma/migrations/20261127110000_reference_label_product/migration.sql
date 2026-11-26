-- A reference label filed from a drop is linked to its product (26 Nov). Additive, nullable.
ALTER TABLE "reference_labels" ADD COLUMN IF NOT EXISTS "product_id" TEXT;
CREATE INDEX IF NOT EXISTS "reference_labels_product_id_idx" ON "reference_labels" ("product_id");
