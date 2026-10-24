-- Per-product certificate profile (additive only): product values a certificate
-- needed, proven by a verbatim quote or confirmed by a person, read by code on
-- the next invoice. Rows go with their product / company.
CREATE TABLE "product_certificate_values" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by_user_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "source_invoice_id" TEXT,
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_certificate_values_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_certificate_values_company_id_product_id_key_key" ON "product_certificate_values"("company_id", "product_id", "key");
CREATE INDEX "product_certificate_values_product_id_idx" ON "product_certificate_values"("product_id");
ALTER TABLE "product_certificate_values" ADD CONSTRAINT "product_certificate_values_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_certificate_values" ADD CONSTRAINT "product_certificate_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
