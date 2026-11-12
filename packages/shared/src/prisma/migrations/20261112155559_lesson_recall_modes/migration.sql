CREATE TYPE "LessonRecallArm" AS ENUM ('ON', 'SHADOW', 'OFF');

ALTER TABLE "workflow_runs"
  ADD COLUMN "lesson_recall_arm" "LessonRecallArm",
  ADD COLUMN "lesson_recall_held_out" BOOLEAN NOT NULL DEFAULT false;
