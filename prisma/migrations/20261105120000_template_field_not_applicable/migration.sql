-- A field empty on purpose (owner setting); required = false no longer means that.
ALTER TABLE "template_fields" ADD COLUMN "not_applicable" BOOLEAN NOT NULL DEFAULT false;
