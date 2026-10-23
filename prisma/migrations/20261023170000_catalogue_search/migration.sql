-- Catalogue search (plan.md §15.6, A6.6). Additive: an extension and two
-- expression indexes; no column changes. The FTS and trigram expressions here
-- must stay identical to the ones in services/catalogues/searchService.js, or
-- the planner won't use the indexes.

-- fuzzy product names (pg_trgm ships with Postgres contrib; creating it needs a
-- role with CREATE on the database — the app role in docker-compose is the owner)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- full text over the printed block ('simple': no stemming / stop words — codes,
-- doses and "None" stay searchable as printed)
CREATE INDEX IF NOT EXISTS "catalogue_blocks_fts_idx"
  ON "catalogue_blocks" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || "text"));

-- the product name the review settled on (extracted), else the printed title
CREATE INDEX IF NOT EXISTS "catalogue_blocks_name_trgm_idx"
  ON "catalogue_blocks" USING gin ((lower(coalesce("extracted" #>> '{record,name}', "title", ''))) gin_trgm_ops);
