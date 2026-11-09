-- CreateTable
CREATE TABLE "pr_review_visits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pull_request_id" UUID NOT NULL,
    "last_head_sha" TEXT NOT NULL,
    "first_visited_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_visited_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_review_visits_pull_request_id_idx" ON "pr_review_visits"("pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "pr_review_visits_user_id_pull_request_id_key" ON "pr_review_visits"("user_id", "pull_request_id");

-- AddForeignKey
ALTER TABLE "pr_review_visits" ADD CONSTRAINT "pr_review_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_review_visits" ADD CONSTRAINT "pr_review_visits_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
