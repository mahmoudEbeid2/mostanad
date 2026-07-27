-- AlterTable
ALTER TABLE "reference_labels" ADD COLUMN "brand_id" TEXT;

-- AddForeignKey
ALTER TABLE "reference_labels" ADD CONSTRAINT "reference_labels_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
