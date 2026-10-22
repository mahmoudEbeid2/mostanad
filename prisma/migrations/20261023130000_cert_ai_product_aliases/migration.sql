-- Certificate AI layers, Phase A3 — product matching (plan.md §4, §7).
-- Additive only: one new table. InvoiceItem.match_method gains the values alias | ai_confirmed (a free-text column: no DDL).


CREATE TABLE "product_aliases" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "alias_norm" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "times_used" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_aliases_company_id_alias_norm_key" ON "product_aliases"("company_id", "alias_norm");

ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

