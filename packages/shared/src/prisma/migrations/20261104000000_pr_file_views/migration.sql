-- CreateTable
CREATE TABLE "pr_file_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "patch_digest" TEXT NOT NULL,
    "viewed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_file_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_file_views_pull_request_id_idx" ON "pr_file_views"("pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "pr_file_views_user_id_pull_request_id_path_key" ON "pr_file_views"("user_id", "pull_request_id", "path");

-- AddForeignKey
ALTER TABLE "pr_file_views" ADD CONSTRAINT "pr_file_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_file_views" ADD CONSTRAINT "pr_file_views_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
