-- 28 Nov: the harvest reads the files natively with Gemini (additive only)

-- a file uploaded to the Gemini File API, by content: reused while Google keeps it (48 h), re-uploaded after
CREATE TABLE IF NOT EXISTS "gemini_files" (
  "id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "uri" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gemini_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "gemini_files_sha256_expires_at_idx" ON "gemini_files" ("sha256", "expires_at");

-- who read a fact (rules | ai), and whether the verification pass agreed with it
ALTER TABLE "harvested_facts" ADD COLUMN IF NOT EXISTS "extractor" TEXT NOT NULL DEFAULT 'rules';
ALTER TABLE "harvested_facts" ADD COLUMN IF NOT EXISTS "review_status" TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE "harvested_facts" ADD COLUMN IF NOT EXISTS "verify_note" TEXT;
ALTER TABLE "harvested_facts" ADD COLUMN IF NOT EXISTS "model_id" TEXT;
ALTER TABLE "harvested_facts" ADD COLUMN IF NOT EXISTS "unit" TEXT;

-- a drop's harvest: progress, per-file outcome, the values read (before a company exists), tokens and cost
ALTER TABLE "intake_batches" ADD COLUMN IF NOT EXISTS "harvest" JSONB;
