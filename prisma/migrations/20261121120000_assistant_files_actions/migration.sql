-- Assistant C2: files in the chat and actions with confirmation. Additive only.
ALTER TABLE "assistant_messages" ADD COLUMN "attachments" JSONB;

CREATE TABLE "assistant_attachments" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "pages" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_attachments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_attachments_conversation_id_idx" ON "assistant_attachments"("conversation_id");
CREATE INDEX "assistant_attachments_company_id_idx" ON "assistant_attachments"("company_id");
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assistant_actions" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "args_hash" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_by_type" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "task_id" TEXT,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_actions_conversation_id_created_at_idx" ON "assistant_actions"("conversation_id", "created_at");
CREATE INDEX "assistant_actions_owner_type_owner_id_created_at_idx" ON "assistant_actions"("owner_type", "owner_id", "created_at");
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
