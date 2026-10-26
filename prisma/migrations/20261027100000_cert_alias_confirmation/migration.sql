-- Product aliases need an explicit person's confirmation (owner, 2026-10-27), additive only:
-- who confirmed, when, and on which invoice line. Existing rows stay (no confirmed_at) and the
-- matcher no longer reads them.
-- AlterTable
ALTER TABLE "product_aliases" ADD COLUMN "confirmed_at" TIMESTAMP(3),
ADD COLUMN "confirmed_by_user_id" TEXT,
ADD COLUMN "source_invoice_id" TEXT,
ADD COLUMN "source_invoice_item_id" TEXT;
