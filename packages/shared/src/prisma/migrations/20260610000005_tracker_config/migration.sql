-- CreateTable: singleton issue-tracker connector config (EVOL-5).
-- Same pattern as the other system-config singletons: id = 'default'
-- enforced by CHECK, secret stored in the AES-256-GCM envelope columns
-- (ciphertext + nonce + auth_tag + key_version + last_four).

CREATE TABLE "tracker_config" (
    "id"                     TEXT         NOT NULL DEFAULT 'default',
    "provider"               TEXT,
    "base_url"               TEXT,
    "email"                  TEXT,
    "api_token_ciphertext"   BYTEA,
    "api_token_nonce"        BYTEA,
    "api_token_auth_tag"     BYTEA,
    "api_token_key_version"  INTEGER,
    "api_token_last_four"    TEXT,
    "updated_at"             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "tracker_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tracker_config_singleton" CHECK ("id" = 'default'),
    CONSTRAINT "tracker_config_provider_check" CHECK ("provider" IS NULL OR "provider" IN ('jira', 'linear', 'github'))
);
