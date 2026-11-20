-- Assistant: table blocks (rows shown by the UI, not typed by the model), the tool facts an answer is
-- checked against, and the grounding check result. Additive only.
ALTER TABLE "assistant_messages" ADD COLUMN "blocks" JSONB;
ALTER TABLE "assistant_messages" ADD COLUMN "facts" TEXT;
ALTER TABLE "assistant_messages" ADD COLUMN "grounding" JSONB;
