-- In-app assistant (C0): conversations, messages, tool-call audit, per-company settings. Additive only.
CREATE TABLE "assistant_conversations" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "company_id" TEXT,
    "title" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_conversations_owner_type_owner_id_updated_at_idx" ON "assistant_conversations"("owner_type", "owner_id", "updated_at");

CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "company_id" TEXT,
    "page" JSONB,
    "tool_calls" JSONB,
    "links" JSONB,
    "error" TEXT,
    "model_id" TEXT,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "thinking_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(18,10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at");
CREATE INDEX "assistant_messages_scope_key_created_at_idx" ON "assistant_messages"("scope_key", "created_at");
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assistant_tool_calls" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB,
    "company_id" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistant_tool_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_tool_calls_conversation_id_created_at_idx" ON "assistant_tool_calls"("conversation_id", "created_at");
CREATE INDEX "assistant_tool_calls_owner_type_owner_id_created_at_idx" ON "assistant_tool_calls"("owner_type", "owner_id", "created_at");
ALTER TABLE "assistant_tool_calls" ADD CONSTRAINT "assistant_tool_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assistant_settings" (
    "id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "messages_per_user_per_hour" INTEGER,
    "model_calls_per_day" INTEGER,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assistant_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "assistant_settings_scope_key_key" ON "assistant_settings"("scope_key");
