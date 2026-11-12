CREATE TYPE "EvalLessonSource" AS ENUM ('AUTHORED', 'IMPORTED');
ALTER TABLE "eval_runs"
  ADD COLUMN "candidate_memory_mode" "LessonRecallArm" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "baseline_memory_mode" "LessonRecallArm" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "corpus_hash" TEXT;
CREATE TABLE "eval_lessons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dataset_id" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "failure_type" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "embedding" vector(1536) NOT NULL,
  "embedding_model" TEXT NOT NULL,
  "source" "EvalLessonSource" NOT NULL DEFAULT 'AUTHORED',
  "source_memory_item_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "eval_lessons_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_lessons_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "eval_lessons_dataset_id_idx" ON "eval_lessons"("dataset_id");
