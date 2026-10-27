-- Owner, 2026-10-27: two protected classes are never generated — lab results (is_lab_result) and
-- batch facts (new, below); every other certificate field may be generated (inference from the
-- product's data and general knowledge of its type, the web), always marked estimated.
-- Additive only: one new nullable column (null = the owner hasn't decided: the label pre-set applies);
-- two idempotent backfills.

-- AlterTable
ALTER TABLE "template_fields" ADD COLUMN "is_batch_fact" BOOLEAN;

-- Pre-set (same rule as policy.defaultIsBatchFact): batch / lot labels, production / manufacturing /
-- expiry dates, and the invoice line's batch / date sources. Lab results keep their own flag.
UPDATE "template_fields"
SET "is_batch_fact" = true
WHERE "is_batch_fact" IS NULL
  AND "is_lab_result" = false
  AND (
    "label" ~* '\m(batch|lot)\M'
    OR "label" ~* '\m(expir\w*|exp\.?\s*date|best\s*before|use\s*by)\M'
    OR "label" ~* '\m(production|manufactur\w*|mfg|mfd|prod\.?)\s*(date|dt)\M'
    OR ("source"->>'kind' = 'item' AND "source"->>'path' IN ('batchNo', 'lotNo', 'expiryDate', 'productionDate', 'manufacturingDate'))
  );

-- Open inference + web for every field that may now be generated: not a lab result, not a batch
-- fact, not a value owned by the invoice / company / fixed text (policy.defaultPolicy).
UPDATE "template_fields"
SET "inference_policy" = 'product_facts_and_web'
WHERE "inference_policy" <> 'product_facts_and_web'
  AND "is_lab_result" = false
  AND "is_batch_fact" IS NOT TRUE
  AND COALESCE("data_category", '') NOT IN ('batch_data', 'invoice_line', 'invoice_header', 'company', 'constant')
  AND COALESCE("source"->>'kind', 'manual') NOT IN ('item', 'invoice', 'company', 'today', 'static')
  AND "group_key" IS NULL;
