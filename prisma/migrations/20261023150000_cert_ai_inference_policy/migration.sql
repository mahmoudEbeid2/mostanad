-- Certificate AI layers, Phase A5 — inference from product data & web lookup (plan.md §14).
-- Additive: one column with a default. Backfill (idempotent) from the field's category (§14.1):
-- product data may use tiers I and W; everything else (batch data, invoice values, company,
-- constants, unknown) stays "never". A field without a category that reads a product or brand
-- path is product data.
ALTER TABLE "template_fields" ADD COLUMN "inference_policy" TEXT NOT NULL DEFAULT 'never';
UPDATE "template_fields" SET "inference_policy" = 'product_facts_and_web'
WHERE "inference_policy" = 'never'
  AND ("data_category" = 'product_data'
       OR ("data_category" IS NULL AND "group_key" IS NULL AND "source"->>'kind' IN ('product', 'brand')));
