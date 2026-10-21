-- Phase 7 (CERTIFICATES_V2_PLAN.md §7.8): repeating groups. Additive only.
ALTER TABLE "template_versions" ADD COLUMN "background_format" TEXT NOT NULL DEFAULT 'png';

CREATE TABLE "template_groups" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'repeat',
    "source" JSONB NOT NULL,
    "when_empty" TEXT NOT NULL DEFAULT 'dash',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sample_rows" INTEGER,
    "footer_y" DOUBLE PRECISION,
    "min_pitch_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "geometry" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "template_groups_version_id_key_key" ON "template_groups"("version_id", "key");

ALTER TABLE "template_groups" ADD CONSTRAINT "template_groups_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
