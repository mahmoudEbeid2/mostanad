-- "Express" (urgent order from the chat): a drop filed AND turned into certificate drafts at once.
-- Everything it made is listed for review (intake_created), certificates stay drafts. Additive.
ALTER TABLE "intake_batches" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "intake_batches" ADD COLUMN "express" JSONB;
ALTER TABLE "intake_created" ADD COLUMN "reviewed_at" TIMESTAMP(3);
ALTER TABLE "intake_created" ADD COLUMN "reviewed_by_user_id" TEXT;
CREATE INDEX "intake_created_company_id_reviewed_at_idx" ON "intake_created"("company_id", "reviewed_at");
-- a batch's certificates as one PDF, next to its ZIP
ALTER TABLE "certificate_batches" ADD COLUMN "combined_pdf_file_id" TEXT;
-- a "create the company" card (system users) belongs to no company yet; every other card still names one (code-enforced)
ALTER TABLE "assistant_actions" ALTER COLUMN "company_id" DROP NOT NULL;
