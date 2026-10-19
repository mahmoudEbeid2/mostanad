-- Review #5: the stuck-batch cutoff uses the batch's last progress, not its creation time. Additive only.
ALTER TABLE "certificate_batches" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
