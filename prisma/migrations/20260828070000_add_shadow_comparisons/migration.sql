-- CreateTable
CREATE TABLE "shadow_comparisons" (
    "id" TEXT NOT NULL,
    "label_id" TEXT,
    "old_engine_result" JSONB NOT NULL,
    "new_engine_result" JSONB NOT NULL,
    "fields_differed" TEXT[],
    "verdict_differed" BOOLEAN NOT NULL,
    "latency_delta_ms" INTEGER,
    "cost_delta" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shadow_comparisons_created_at_idx" ON "shadow_comparisons"("created_at");

