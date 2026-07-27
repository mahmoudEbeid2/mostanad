-- CreateTable
CREATE TABLE "reference_labels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extractedData" JSONB,
    "company_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_labels_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "reference_labels" ADD CONSTRAINT "reference_labels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
