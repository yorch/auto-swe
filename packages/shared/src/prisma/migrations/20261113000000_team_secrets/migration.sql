-- CreateTable
CREATE TABLE "team_secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value_ciphertext" BYTEA NOT NULL,
    "value_nonce" BYTEA NOT NULL,
    "value_auth_tag" BYTEA NOT NULL,
    "value_key_version" INTEGER NOT NULL,
    "value_last_four" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_secret_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_secret_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_secret_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_secrets_team_id_name_key" ON "team_secrets"("team_id", "name");

-- CreateIndex
CREATE INDEX "team_secret_grants_connection_id_idx" ON "team_secret_grants"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_secret_grants_team_secret_id_connection_id_key" ON "team_secret_grants"("team_secret_id", "connection_id");

-- AddForeignKey
ALTER TABLE "team_secrets" ADD CONSTRAINT "team_secrets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_secrets" ADD CONSTRAINT "team_secrets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_secret_grants" ADD CONSTRAINT "team_secret_grants_team_secret_id_fkey" FOREIGN KEY ("team_secret_id") REFERENCES "team_secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_secret_grants" ADD CONSTRAINT "team_secret_grants_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_secret_grants" ADD CONSTRAINT "team_secret_grants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
