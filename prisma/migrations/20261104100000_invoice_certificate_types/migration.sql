-- Which certificate types an invoice makes. NULL = every type with an active template,
-- including types activated later; a JSON array of ids = only those types. Existing rows stay
-- NULL, so nothing changes for them. JSONB, not uuid[]: Prisma can't model a nullable list.
ALTER TABLE "invoices" ADD COLUMN "certificate_type_ids" JSONB;
ALTER TABLE "companies" ADD COLUMN "default_certificate_type_ids" JSONB;
