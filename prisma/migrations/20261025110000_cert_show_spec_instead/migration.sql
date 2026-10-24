-- "Show the specification instead of the result" (additive only): an owner
-- setting per lab-result field, and the specification field it prints.
ALTER TABLE "template_fields" ADD COLUMN "show_spec_instead" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "template_fields" ADD COLUMN "spec_field_key" TEXT;
