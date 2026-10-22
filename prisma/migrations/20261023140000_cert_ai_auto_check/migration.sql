-- Certificate AI layers, post-A4: automatic data check + visible match status.
-- Additive only: two nullable columns. Existing invoices keep NULL (= check never ran → V2 generate behaviour).
ALTER TABLE "invoices" ADD COLUMN "match_summary" JSONB;
ALTER TABLE "invoices" ADD COLUMN "data_checked_at" TIMESTAMP(3);
