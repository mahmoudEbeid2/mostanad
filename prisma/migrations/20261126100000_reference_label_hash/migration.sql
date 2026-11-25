-- Reference label duplicates are recognised by the file's content, not its name
-- (a corrected label re-uploaded under the same name was skipped). Additive.
ALTER TABLE "reference_labels" ADD COLUMN "source_sha256" TEXT;
CREATE INDEX "reference_labels_company_id_source_sha256_idx" ON "reference_labels"("company_id", "source_sha256");
