-- AlterTable
ALTER TABLE "eda_requirements" ADD COLUMN "company_id" TEXT;

-- AddForeignKey
ALTER TABLE "eda_requirements" ADD CONSTRAINT "eda_requirements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
