-- Assistant: edit / resend a message. The edited message and every message after it are hidden, not
-- deleted: the hourly message limit and the daily AI-call budget still count them. Additive only.
ALTER TABLE "assistant_messages" ADD COLUMN "superseded_at" TIMESTAMP(3);
