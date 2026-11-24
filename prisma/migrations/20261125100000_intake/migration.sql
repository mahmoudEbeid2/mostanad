-- Auto-intake (drop any files → recognised and filed). Additive: three new tables.
-- CreateTable
CREATE TABLE "intake_batches" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "company_id" TEXT,
    "conversation_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "classify_task_id" TEXT,
    "execute_task_id" TEXT,
    "summary" JSONB,
    "ai_calls" INTEGER NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMP(3),
    "executed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intake_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "rel_path" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "received_bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "mime_type" TEXT,
    "file_id" TEXT,
    "page_from" INTEGER,
    "page_to" INTEGER,
    "company_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "classification" JSONB,
    "decision" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "ai_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intake_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_created" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "item_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_created_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intake_batches_owner_type_owner_id_created_at_idx" ON "intake_batches"("owner_type", "owner_id", "created_at");

-- CreateIndex
CREATE INDEX "intake_items_batch_id_idx" ON "intake_items"("batch_id");

-- CreateIndex
CREATE INDEX "intake_items_company_id_sha256_idx" ON "intake_items"("company_id", "sha256");

-- CreateIndex
CREATE INDEX "intake_created_entity_type_entity_id_idx" ON "intake_created"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "intake_created_company_id_idx" ON "intake_created"("company_id");

-- AddForeignKey
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "intake_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_created" ADD CONSTRAINT "intake_created_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "intake_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

