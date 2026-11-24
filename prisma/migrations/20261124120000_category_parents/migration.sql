-- Categories get an optional parent (one level: a main category and the ones
-- under it) and a sort order for the main ones. Additive only: two nullable
-- columns and one new row. Nothing is renamed, merged or moved here; which
-- existing category sits under which main one is set by
-- scripts/categoryParents.js once the mapping is approved.
ALTER TABLE "categories" ADD COLUMN "parent_id" TEXT;
ALTER TABLE "categories" ADD COLUMN "sort_order" INTEGER;

ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- The client's five main categories: Feed Additives, Supplement, Injection, Antibiotic(s), Premix.
-- Premix did not exist; it is added. The others keep their names and get an order.
INSERT INTO "categories" ("id", "name", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'Premix', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "categories" WHERE lower("name") = 'premix');

UPDATE "categories" SET "sort_order" = 1 WHERE "name" = 'Feed Additives' AND "sort_order" IS NULL;
UPDATE "categories" SET "sort_order" = 2 WHERE "name" = 'Supplement' AND "sort_order" IS NULL;
UPDATE "categories" SET "sort_order" = 3 WHERE "name" = 'Injection' AND "sort_order" IS NULL;
UPDATE "categories" SET "sort_order" = 4 WHERE "name" IN ('Antibiotic', 'Antibiotics') AND "sort_order" IS NULL;
UPDATE "categories" SET "sort_order" = 5 WHERE lower("name") = 'premix' AND "sort_order" IS NULL;
