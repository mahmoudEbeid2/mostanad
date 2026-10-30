-- Catalogue upload (C0/C1 v2). Additive: new nullable columns; pages no longer need a kind.
-- A job's progress is kept on its row, so polling sees it without the socket.
ALTER TABLE "background_tasks"
  ADD COLUMN "progress" INTEGER,
  ADD COLUMN "message" TEXT,
  ADD COLUMN "stage" TEXT,
  ADD COLUMN "stages" JSONB;

-- A person chooses the pages: new rows carry no kind (older rows keep theirs).
ALTER TABLE "catalogue_pages" ALTER COLUMN "kind" DROP NOT NULL;

-- The running extraction's task, for the progress shown in the catalogue list.
ALTER TABLE "catalogue_versions" ADD COLUMN "extract_task_id" TEXT;
