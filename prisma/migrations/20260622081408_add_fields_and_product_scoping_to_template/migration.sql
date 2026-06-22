-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "fields" JSONB,
ADD COLUMN     "is_global" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "product_id" TEXT;
