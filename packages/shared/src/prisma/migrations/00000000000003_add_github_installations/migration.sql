-- A GitHub App installation on one GitHub account. The `GitHubConfig` singleton
-- keeps the App's own credentials, which are instance-wide; where the App is
-- installed is not, and reaching repositories across several GitHub
-- organizations means several installations.
--
-- `connections.installation_id` is nullable and defaults to NULL, which means
-- "the singleton's app_installation_id" — so an existing single-org deployment
-- keeps working with every row untouched.
--
-- ON DELETE RESTRICT: reverting a repository to the default installation would
-- silently send its clone and permission lookups to a different GitHub account,
-- and a permission answer from the wrong account is worse than an error.
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "installation_id" TEXT NOT NULL,
    "account_login" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

ALTER TABLE "connections" ADD COLUMN "installation_id" UUID;

CREATE INDEX "connections_installation_id_idx" ON "connections"("installation_id");

ALTER TABLE "connections" ADD CONSTRAINT "connections_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
