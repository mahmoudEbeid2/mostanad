-- "Copy to another brand": a copy's link to its original (additive, nullable).
ALTER TABLE "products" ADD COLUMN "source_product_id" TEXT;
CREATE INDEX "products_source_product_id_idx" ON "products"("source_product_id");
ALTER TABLE "products" ADD CONSTRAINT "products_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
