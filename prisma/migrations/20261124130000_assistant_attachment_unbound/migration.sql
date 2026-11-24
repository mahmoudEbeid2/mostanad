-- A file attached in the assistant while "All companies" is picked is kept in
-- the conversation without a company until the person picks one (it is then
-- bound). Additive: the column only stops requiring a value; every existing
-- row keeps its company.
ALTER TABLE "assistant_attachments" ALTER COLUMN "company_id" DROP NOT NULL;
