-- CreateTable
CREATE TABLE "golden_eval_runs" (
    "id" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engine_version" TEXT NOT NULL,
    "model_id" TEXT,
    "prompt_hash" TEXT,
    "field_accuracy" JSONB NOT NULL,
    "overall_accuracy" DOUBLE PRECISION NOT NULL,
    "baseline_accuracy" DOUBLE PRECISION,
    "regressed" BOOLEAN NOT NULL DEFAULT false,
    "blocked_deploy" BOOLEAN NOT NULL DEFAULT false,
    "case_count" INTEGER NOT NULL DEFAULT 0,
    "failed_case_ids" TEXT[],

    CONSTRAINT "golden_eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "golden_eval_runs_run_at_idx" ON "golden_eval_runs"("run_at");

