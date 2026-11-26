-- PART 3 (28 Nov): experiment mode — the certificate policy off for one company or all, to judge fully
-- filled output. Everything made in it is a watermarked sample that can never become valid (additive only)

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "experiment_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "experiment_mode_by" TEXT;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "experiment_mode_at" TIMESTAMP(3);

-- one row per app-wide setting; experiment_mode_global = { on, by, byName, at }
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updated_by_user_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- a certificate made in experiment mode: never approved, finalized, exported clean or revised into a valid one
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "is_experiment_sample" BOOLEAN NOT NULL DEFAULT false;

-- every toggle and every generation in the mode: who, when, company, which fields the AI filled
CREATE TABLE IF NOT EXISTS "experiment_audit" (
  "id" TEXT NOT NULL,
  "company_id" TEXT,
  "action" TEXT NOT NULL,
  "user_id" TEXT,
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "experiment_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "experiment_audit_company_id_created_at_idx" ON "experiment_audit" ("company_id", "created_at");
