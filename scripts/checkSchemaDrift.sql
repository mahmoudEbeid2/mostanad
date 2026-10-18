-- Read-only schema-drift check. Run this against staging/production yourself
-- (never run automatically by an agent):
--
--   psql "$DATABASE_URL" -f scripts/checkSchemaDrift.sql
--
-- It does not write anything — SELECTs only. It catches the exact class of
-- drift found in dev on 2026-09-13: the migration ledger (_prisma_migrations)
-- claiming a migration is applied while the table/column it should have
-- created doesn't actually exist, because `prisma migrate status` only
-- checks the LEDGER, never the live schema, so it can report "up to date"
-- while tables are silently missing.
--
-- Regenerate the two VALUES lists below whenever migrations/schema.prisma
-- change: table list from `grep -oP '@@map\("\K[^"]+' prisma/schema.prisma`,
-- migration list from `ls prisma/migrations` (excluding migration_lock.toml).

-- ── 1. Every table schema.prisma expects, that the live database is missing ──
WITH expected_tables (table_name) AS (
  VALUES
    ('audit_disagreements'), ('background_tasks'), ('brands'), ('categories'),
    ('companies'), ('company_images'), ('external_knowledge_cache'),
    ('generated_labels'), ('golden_eval_runs'), ('label_approvals'),
    ('label_chat_messages'), ('label_versions'), ('permissions'), ('plans'),
    ('products'), ('reference_labels'), ('regulatory_documents'),
    ('regulatory_rules'), ('role_permissions'), ('roles'),
    ('rule_evaluation_outcomes'), ('shadow_comparisons'), ('subscriptions'),
    ('template_images'), ('templates'), ('users'), ('validation_reports')
)
SELECT 'MISSING_TABLE' AS finding, e.table_name
FROM expected_tables e
LEFT JOIN information_schema.tables t
  ON t.table_schema = 'public' AND t.table_name = e.table_name
WHERE t.table_name IS NULL;

-- ── 2. Migration ledger vs. migration folders — both directions ─────────────
-- A name in the ledger but not in this list = a PHANTOM entry (like
-- 20260726224901_sync_all_missing_fields): marked applied, but whatever it
-- did left no trace in the repo, so a fresh environment will never run it.
-- A name in this list but not in the ledger = an UNAPPLIED migration: the
-- live database is missing real schema `migrate deploy` would add.
WITH known_migrations (migration_name) AS (
  VALUES
    ('20260610131719_init'), ('20260610133152_make_role_optional'),
    ('20260610133559_add_user_is_deleted'), ('20260610135145_soft'),
    ('20260614125632_remove_css_content_from_template'),
    ('20260614130539_add_brand_model_and_relations'),
    ('20260614132844_add_type_to_template_model'),
    ('20260622081408_add_fields_and_product_scoping_to_template'),
    ('20260727000000_add_missing_tables'),
    ('20260727060000_multi_tenant_eda_reqs'),
    ('20260727143500_add_reference_label_model'),
    ('20260728021800_add_brand_to_reference_label'),
    ('20260729143000_enhance_reference_labels'),
    ('20260828010000_add_generated_label_core'),
    ('20260828020000_add_golden_eval_run'),
    ('20260828030000_add_regulatory_documents_and_rules'),
    ('20260828040000_add_external_knowledge_cache'),
    ('20260828050000_add_audit_disagreements'),
    ('20260828060000_add_label_approval_and_reference_extension'),
    ('20260828070000_add_shadow_comparisons'),
    ('20260828080000_add_label_verification_fields'),
    ('20260913182628_add_regulatory_catalog_and_rule_extensions'),
    ('20260913192924_add_companies_logo_url')
),
ledger AS (
  SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
)
SELECT 'PHANTOM_LEDGER_ENTRY (applied in DB, no file on disk)' AS finding, l.migration_name
FROM ledger l
LEFT JOIN known_migrations k USING (migration_name)
WHERE k.migration_name IS NULL
UNION ALL
SELECT 'UNAPPLIED_MIGRATION (file exists, DB says not applied)' AS finding, k.migration_name
FROM known_migrations k
LEFT JOIN ledger l USING (migration_name)
WHERE l.migration_name IS NULL;

-- ── 3. Targeted check for the second drift found alongside the first:
--       companies.logo_url exists in every migration-built schema but was
--       found missing from dev, with no DROP COLUMN migration to explain it.
SELECT 'UNEXPECTED_MISSING_COLUMN' AS finding, 'companies.logo_url' AS detail
WHERE NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'logo_url'
);
