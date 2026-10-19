-- CreateTable
CREATE TABLE "package_registries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL DEFAULT 'npm',
    "upstream_url" TEXT NOT NULL,
    "npm_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "access_mode" TEXT NOT NULL DEFAULT 'lockfile',
    "allow_private_network" BOOLEAN NOT NULL DEFAULT false,
    "auth_kind" TEXT NOT NULL DEFAULT 'bearer',
    "team_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_ciphertext" BYTEA,
    "token_nonce" BYTEA,
    "token_auth_tag" BYTEA,
    "token_key_version" INTEGER,
    "token_last_four" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_registries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "package_registries_name_key" ON "package_registries"("name");

-- CreateIndex
CREATE INDEX "package_registries_team_id_idx" ON "package_registries"("team_id");

-- AddForeignKey
ALTER TABLE "package_registries" ADD CONSTRAINT "package_registries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
