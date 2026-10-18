-- Task 1 (2026-09-13) found that every migration-built schema already
-- creates companies.logo_url, but this dev database's live companies table
-- was missing it — something dropped it outside the migration history at
-- some point (most likely explanation: the phantom ledger entry
-- 20260726224901_sync_all_missing_fields, see PROGRESS notes; not deleted,
-- not touched here). Additive only: adds the column back where it's missing,
-- a no-op anywhere it already exists. Declared in schema.prisma so every
-- environment converges on a schema that matches the file, per the project's
-- own "migrations are additive only, never destructive" invariant — the
-- alternative (dropping the column to match dev) would have been destructive.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "logo_url" TEXT;
