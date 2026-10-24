-- AI cost ledger (additive only): one row per Gemini request attempt, and the
-- monthly Google Cloud billing amount entered for reconciliation.
CREATE TABLE "ai_calls" (
    "id" TEXT NOT NULL,
    "company_id" TEXT,
    "user_id" TEXT,
    "feature" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "parent_type" TEXT,
    "parent_id" TEXT,
    "ai_run_id" TEXT,
    "model_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "http_status" INTEGER,
    "error" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "thinking_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,10),
    "price_effective_from" TIMESTAMP(3),
    "price_input_per_m" DECIMAL(12,6),
    "price_cached_per_m" DECIMAL(12,6),
    "price_output_per_m" DECIMAL(12,6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_calls_company_id_created_at_idx" ON "ai_calls"("company_id", "created_at");
CREATE INDEX "ai_calls_feature_created_at_idx" ON "ai_calls"("feature", "created_at");
CREATE INDEX "ai_calls_entity_type_entity_id_idx" ON "ai_calls"("entity_type", "entity_id");
CREATE INDEX "ai_calls_parent_type_parent_id_idx" ON "ai_calls"("parent_type", "parent_id");
CREATE INDEX "ai_calls_ai_run_id_idx" ON "ai_calls"("ai_run_id");
CREATE INDEX "ai_calls_created_at_idx" ON "ai_calls"("created_at");

CREATE TABLE "ai_billing_months" (
    "month" TEXT NOT NULL,
    "billed_usd" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_billing_months_pkey" PRIMARY KEY ("month")
);
