-- Lab-result flag on template fields (additive only). A per-batch analysis
-- result is never inferred, looked up on the web, read from a catalogue or a
-- product profile (policy.js hard line).
ALTER TABLE "template_fields" ADD COLUMN "is_lab_result" BOOLEAN NOT NULL DEFAULT false;

-- Pre-set (idempotent: only rows still false are touched, and the same rule
-- gives the same answer on a re-run): batch-data fields, and labels naming a
-- result, an assay or a pass/fail word. The owner unticks what isn't one.
UPDATE "template_fields"
SET "is_lab_result" = true
WHERE "is_lab_result" = false
  AND ("data_category" = 'batch_data' OR "label" ~* '\m(results?|assay|complies|conforms?)\M');
