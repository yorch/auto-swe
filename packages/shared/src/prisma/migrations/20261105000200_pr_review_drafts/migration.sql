-- CreateTable
CREATE TABLE "pr_review_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "patch_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_review_drafts_user_id_pull_request_id_idx" ON "pr_review_drafts"("user_id", "pull_request_id");

-- CreateIndex
CREATE INDEX "pr_review_drafts_pull_request_id_idx" ON "pr_review_drafts"("pull_request_id");

-- AddForeignKey
ALTER TABLE "pr_review_drafts" ADD CONSTRAINT "pr_review_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_review_drafts" ADD CONSTRAINT "pr_review_drafts_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
