-- ----------------------------------------------------------------------------
-- Figma integration (P0/P1): a singleton config table for the Figma design
-- connector + a compact design-summary column on context_snapshots seeded at
-- work-request submit time. Both additive — safe to apply on a live DB.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "figma_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "api_token_ciphertext" BYTEA,
    "api_token_nonce" BYTEA,
    "api_token_auth_tag" BYTEA,
    "api_token_key_version" INTEGER,
    "api_token_last_four" TEXT,
    "max_nodes" INTEGER DEFAULT 12,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "figma_config_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "context_snapshots" ADD COLUMN "raw_design" JSONB;
