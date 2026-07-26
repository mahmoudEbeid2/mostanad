-- CreateTable
CREATE TABLE "background_tasks" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "company_id" TEXT,
    "brand_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eda_requirements" (
    "id" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractedData" JSONB,
    "country" TEXT NOT NULL DEFAULT 'Egypt',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eda_requirements_pkey" PRIMARY KEY ("id")
);
