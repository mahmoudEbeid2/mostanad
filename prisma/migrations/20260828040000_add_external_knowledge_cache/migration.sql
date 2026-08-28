-- CreateTable
CREATE TABLE "external_knowledge_cache" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lookup_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT,
    "source_type" TEXT NOT NULL,
    "source_urls" TEXT[],
    "source_is_authoritative" BOOLEAN NOT NULL DEFAULT false,
    "citations" JSONB,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unreviewed',
    "reviewed_by_user_id" TEXT,
    "retrieved_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_knowledge_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_knowledge_cache_kind_status_idx" ON "external_knowledge_cache"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "external_knowledge_cache_kind_lookup_key_key" ON "external_knowledge_cache"("kind", "lookup_key");

