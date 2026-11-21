-- Assistant: operation drafts (slot filling). One row per pending operation: the values collected
-- so far (each with its source), what is missing, which prerequisites block it, and its status.
-- A confirmation card is made only from a ready draft (assistant_actions.draft_id). Additive only.
CREATE TABLE "assistant_drafts" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "company_id" TEXT,
    "tool" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "missing" JSONB NOT NULL,
    "blocked_by" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "action_id" TEXT,
    "args_hash" TEXT,
    "watch" TEXT,
    "error" TEXT,
    "result" JSONB,
    "message_ids" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_drafts_conversation_id_status_idx" ON "assistant_drafts"("conversation_id", "status");
CREATE INDEX "assistant_drafts_owner_type_owner_id_updated_at_idx" ON "assistant_drafts"("owner_type", "owner_id", "updated_at");

ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_actions" ADD COLUMN "draft_id" TEXT;
