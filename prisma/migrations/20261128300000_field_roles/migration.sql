-- 28 Nov, Phase 1: what a template field IS for the certificate (composition_name | composition_amount |
-- composition_basis …) — a COC composition row is product data, never a lab result (additive)
ALTER TABLE "template_fields" ADD COLUMN IF NOT EXISTS "role" TEXT;
