-- The client's certificate workflow (Dossira_Certificate_Workflow_EN, 26 Nov). Additive only.
-- Review: Draft → In review → Awaiting authorization → Approved (final) → Exported; a reviewer
-- returns a document with a field-specific comment.
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "review_status" TEXT;            -- null | in_review | awaiting_authorization | returned
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "review_comments" JSONB;         -- [{ field, comment, byUserId, at, resolvedAt }]
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "exported_at" TIMESTAMP(3);
-- a change after approval is a new revision of the same document
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "revision_of_id" TEXT;
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "revision_number" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS "certificates_revision_of_id_idx" ON "certificates" ("revision_of_id");
-- the composition basis, stored apart from the pack size ("per 100 mL" for a 50 mL pack)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "composition_basis" TEXT;
-- sources that disagree on an ingredient: both values, compared on one basis, the reviewer's decision
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "composition_review" JSONB;
-- design-only estimates (appearance, pH) — never a COA result
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "design_estimates" JSONB;
