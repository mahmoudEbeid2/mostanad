-- Phase 3 (28 Nov): a certificate's own number — the company's numbering per certificate type, and every
-- number given out once (additive only)

-- the scheme: learnt from the company's documents (detected), the default, or set by a person (user)
CREATE TABLE IF NOT EXISTS "numbering_schemes" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "cert_code" TEXT NOT NULL,
  "pattern" TEXT NOT NULL,
  "last_seq" INTEGER NOT NULL DEFAULT 0,
  "confirmed" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL DEFAULT 'default',
  "example" TEXT,
  "updated_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "numbering_schemes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "numbering_schemes_company_id_cert_code_key" ON "numbering_schemes" ("company_id", "cert_code");

-- every number given out: never twice in a company
CREATE TABLE IF NOT EXISTS "document_numbers" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "cert_code" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "certificate_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "document_numbers_company_id_number_key" ON "document_numbers" ("company_id", "number");
