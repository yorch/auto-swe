-- Migration: 20260618000000_issue_tracker_kb
-- Replace tracker_config with issue_tracker_config + knowledge_base_config
-- Rename context_snapshots column aliases

-- 1. Create issue_tracker_config (superset of tracker_config)
CREATE TABLE "issue_tracker_config" (
  "id"                           TEXT        NOT NULL DEFAULT 'default',
  "provider"                     TEXT,
  "instance_type"                TEXT        DEFAULT 'cloud',
  "base_url"                     TEXT,
  "email"                        TEXT,
  "api_token_ciphertext"         BYTEA,
  "api_token_nonce"              BYTEA,
  "api_token_auth_tag"           BYTEA,
  "api_token_key_version"        INTEGER,
  "api_token_last_four"          TEXT,
  "timeout_ms"                   INTEGER     DEFAULT 5000,
  "max_retries"                  INTEGER     DEFAULT 3,
  "story_points_field_id"        TEXT        DEFAULT 'story_points',
  "epic_issue_type"              TEXT        DEFAULT 'Epic',
  "story_issue_type"             TEXT        DEFAULT 'Story',
  "default_project_key"          TEXT,
  "webhook_secret_ciphertext"    BYTEA,
  "webhook_secret_nonce"         BYTEA,
  "webhook_secret_auth_tag"      BYTEA,
  "webhook_secret_key_version"   INTEGER,
  "webhook_secret_last_four"     TEXT,
  "webhook_trigger_status"       TEXT,
  "updated_at"                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "issue_tracker_config_pkey" PRIMARY KEY ("id")
);

-- 2. Migrate existing tracker_config data
INSERT INTO "issue_tracker_config" (
  "id", "provider", "base_url", "email",
  "api_token_ciphertext", "api_token_nonce", "api_token_auth_tag",
  "api_token_key_version", "api_token_last_four", "updated_at"
)
SELECT
  "id", "provider", "base_url", "email",
  "api_token_ciphertext", "api_token_nonce", "api_token_auth_tag",
  "api_token_key_version", "api_token_last_four", NOW()
FROM "tracker_config"
ON CONFLICT DO NOTHING;

-- 3. Drop old table
DROP TABLE "tracker_config";

-- 4. Create knowledge_base_config
CREATE TABLE "knowledge_base_config" (
  "id"                    TEXT        NOT NULL DEFAULT 'default',
  "provider"              TEXT,
  "enabled"               BOOLEAN     NOT NULL DEFAULT FALSE,
  "base_url"              TEXT,
  "api_token_ciphertext"  BYTEA,
  "api_token_nonce"       BYTEA,
  "api_token_auth_tag"    BYTEA,
  "api_token_key_version" INTEGER,
  "api_token_last_four"   TEXT,
  "email"                 TEXT,
  "spaces"                TEXT[]      NOT NULL DEFAULT '{}',
  "max_pages"             INTEGER     DEFAULT 5,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "knowledge_base_config_pkey" PRIMARY KEY ("id")
);

-- 5. Rename column mappings in context_snapshots
-- raw_jira_epic → raw_ticket_data
ALTER TABLE "context_snapshots" RENAME COLUMN "raw_jira_epic" TO "raw_ticket_data";
-- raw_confluence → raw_documentation
ALTER TABLE "context_snapshots" RENAME COLUMN "raw_confluence" TO "raw_documentation";
