-- Harvest (28 Nov): every value read from every file of a company, with its evidence; the
-- descriptive fields filled from them by priority, disagreements kept for a person. Additive only.
CREATE TABLE IF NOT EXISTS "harvested_facts" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "entity" TEXT NOT NULL,                -- company | product | batch | document | commercial
  "product_id" TEXT,                     -- once matched
  "product_name" TEXT,                   -- as printed (matching key before the product exists)
  "pack" TEXT,                           -- the pack the fact belongs to, when the file says it
  "key" TEXT NOT NULL,                   -- canonical field: category, validity, activeIngredients, batchNo…
  "value" JSONB NOT NULL,
  "value_norm" TEXT,
  "source_type" TEXT NOT NULL,           -- user | certificate | registration | label | catalogue | invoice | mo | lab | list
  "cert_code" TEXT,
  "file_id" TEXT,
  "file_name" TEXT,
  "page" INTEGER,
  "snippet" TEXT,
  "bbox" JSONB,
  "per_batch" BOOLEAN NOT NULL DEFAULT false,
  "batch_no" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harvested_facts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "harvested_facts_company_product_idx" ON "harvested_facts" ("company_id", "product_id");
CREATE INDEX IF NOT EXISTS "harvested_facts_company_name_idx" ON "harvested_facts" ("company_id", "product_name");
-- one fact per file / page / key / product / value: a re-harvest adds nothing twice
CREATE UNIQUE INDEX IF NOT EXISTS "harvested_facts_dedupe" ON "harvested_facts" ("company_id", "file_id", "page", "entity", "key", COALESCE("product_name", ''), COALESCE("value_norm", ''));
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "validity" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "harvest_conflicts" JSONB;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "profile" JSONB;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "harvest_conflicts" JSONB;
