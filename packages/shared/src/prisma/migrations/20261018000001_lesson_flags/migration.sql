-- Lesson flags: one person's report that a repository lesson is wrong, with their reason.
--
-- Raised by anyone who can read the lesson, at most one per person per lesson; read and cleared by
-- whoever may delete it. Flags never change recall. Deleting the lesson deletes its flags.

-- CreateTable
CREATE TABLE "lesson_flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "memory_item_id" UUID NOT NULL,
    "flagged_by_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lesson_flags_flagged_by_id_idx" ON "lesson_flags"("flagged_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_flags_memory_item_id_flagged_by_id_key" ON "lesson_flags"("memory_item_id", "flagged_by_id");

-- AddForeignKey
ALTER TABLE "lesson_flags" ADD CONSTRAINT "lesson_flags_memory_item_id_fkey" FOREIGN KEY ("memory_item_id") REFERENCES "memory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_flags" ADD CONSTRAINT "lesson_flags_flagged_by_id_fkey" FOREIGN KEY ("flagged_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

