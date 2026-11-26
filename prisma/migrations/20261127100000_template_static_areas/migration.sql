-- Template readiness (26 Nov): text a person confirmed as "static on purpose" (the same on every certificate)
-- [{ id, text, kind, byUserId, at }]; null = none confirmed. Additive.
ALTER TABLE "template_versions" ADD COLUMN IF NOT EXISTS "static_areas" JSONB;
