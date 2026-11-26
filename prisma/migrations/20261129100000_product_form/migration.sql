-- 29 Nov: what a certificate prints as "Product Form" (ADDVET's COC: "Antibiotic", "Supplement") is not the
-- product's physical form (Liquid, Powder…). Its own column; additive, nullable.
ALTER TABLE "products" ADD COLUMN "product_form" TEXT;
