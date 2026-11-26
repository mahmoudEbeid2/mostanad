-- 28 Nov: what the AI read in one file, by its content (sha256) and model — a re-dropped file is not read
-- again (additive only)
CREATE TABLE IF NOT EXISTS "harvest_file_cache" (
  "id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "doc_type" TEXT,
  "company" TEXT,
  "values" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harvest_file_cache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "harvest_file_cache_sha256_model_key" ON "harvest_file_cache" ("sha256", "model");
