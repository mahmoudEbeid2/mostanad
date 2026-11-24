-- Certificates made for a product without an invoice (the assistant's
-- generate_certificate_for_product) run through the same engine on an internal
-- invoice record of origin 'direct': one line, the product and the batch facts
-- the person gave. Invoice lists leave those out. Additive: one column with a
-- default; every existing invoice is 'upload'.
ALTER TABLE "invoices" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'upload';
