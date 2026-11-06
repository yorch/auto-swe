-- CreateTable
CREATE TABLE "repo_setup_secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value_ciphertext" BYTEA NOT NULL,
    "value_nonce" BYTEA NOT NULL,
    "value_auth_tag" BYTEA NOT NULL,
    "value_key_version" INTEGER NOT NULL,
    "value_last_four" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_setup_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_setup_secrets_connection_id_name_key" ON "repo_setup_secrets"("connection_id", "name");

-- AddForeignKey
ALTER TABLE "repo_setup_secrets" ADD CONSTRAINT "repo_setup_secrets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
