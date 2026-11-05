-- The shipped font matched to each font embedded in a design. NULL = not matched yet:
-- nothing changes for that version until the backfill or a conversion fills it.
ALTER TABLE "template_versions" ADD COLUMN "font_fallbacks" JSONB;
