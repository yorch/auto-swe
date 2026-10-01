-- CreateTable
CREATE TABLE "github_host_webhook_secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_nonce" BYTEA NOT NULL,
    "secret_auth_tag" BYTEA NOT NULL,
    "secret_key_version" INTEGER NOT NULL,
    "secret_last_four" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_host_webhook_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_host_webhook_secrets_host_key" ON "github_host_webhook_secrets"("host");
