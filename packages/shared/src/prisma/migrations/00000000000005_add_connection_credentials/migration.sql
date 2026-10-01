-- One user's own GitHub token for one repository, used only for runs that
-- user launched. Inert unless `github.userCredentialsEnabled` is on and the
-- repository's hosts are in `github.userCredentialHosts`.
--
-- ON DELETE CASCADE on both sides: a token belongs to exactly one user and one
-- repository, and outliving either would leave a secret nobody can reach or
-- revoke from the UI.
CREATE TABLE "connection_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_ciphertext" BYTEA NOT NULL,
    "token_nonce" BYTEA NOT NULL,
    "token_auth_tag" BYTEA NOT NULL,
    "token_key_version" INTEGER NOT NULL,
    "token_last_four" TEXT NOT NULL,
    -- Where the token was verified. A repository repointed afterwards makes
    -- the row unusable rather than sending the token somewhere new.
    "api_origin" TEXT NOT NULL,
    "web_origin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_credentials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "connection_credentials_user_id_idx" ON "connection_credentials"("user_id");

CREATE UNIQUE INDEX "connection_credentials_connection_id_user_id_key" ON "connection_credentials"("connection_id", "user_id");

ALTER TABLE "connection_credentials" ADD CONSTRAINT "connection_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connection_credentials" ADD CONSTRAINT "connection_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who launched each execution, and which Temporal execution created the row.
-- Both nullable: every existing row, and every run started by a webhook or a
-- cron fire, has no launcher and so uses only the platform credential.
ALTER TABLE "workflow_runs" ADD COLUMN "launched_by_id" UUID,
ADD COLUMN "temporal_run_id" TEXT;

CREATE INDEX "workflow_runs_launched_by_id_idx" ON "workflow_runs"("launched_by_id");

ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_launched_by_id_fkey" FOREIGN KEY ("launched_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
