-- Certificate AI layers, Phase A0 (plan.md §3, §4). Additive only: new tables
-- and nullable columns; nothing existing is altered or dropped.
ALTER TABLE "companies" ADD COLUMN "ai_settings" JSONB;
ALTER TABLE "invoices" ADD COLUMN "text_content" TEXT;

CREATE TABLE "data_dictionaries" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "product_count" INTEGER NOT NULL,
    "built_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "data_dictionaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "data_dictionaries_company_id_key" ON "data_dictionaries"("company_id");
ALTER TABLE "data_dictionaries" ADD CONSTRAINT "data_dictionaries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ai_suggestions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "proposal" JSONB NOT NULL,
    "evidence" JSONB,
    "evidence_verified" BOOLEAN,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "final_value" JSONB,
    "model_id" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "dictionary_version" INTEGER,
    "ai_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_suggestions_company_id_kind_status_idx" ON "ai_suggestions"("company_id", "kind", "status");
CREATE INDEX "ai_suggestions_entity_type_entity_id_idx" ON "ai_suggestions"("entity_type", "entity_id");
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ai_runs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "model_id" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "input_hash" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "error" TEXT,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "thinking_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_runs_company_id_kind_created_at_idx" ON "ai_runs"("company_id", "kind", "created_at");
CREATE INDEX "ai_runs_entity_type_entity_id_idx" ON "ai_runs"("entity_type", "entity_id");
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
