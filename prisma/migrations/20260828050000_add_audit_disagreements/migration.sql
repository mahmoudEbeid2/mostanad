-- CreateTable
CREATE TABLE "audit_disagreements" (
    "id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "field_path" TEXT NOT NULL,
    "deterministic_verdict" JSONB NOT NULL,
    "auditor_verdict" JSONB NOT NULL,
    "auditor_reasoning" TEXT NOT NULL,
    "resolution" TEXT,
    "became_rule_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_disagreements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_disagreements_label_id_version_number_idx" ON "audit_disagreements"("label_id", "version_number");

