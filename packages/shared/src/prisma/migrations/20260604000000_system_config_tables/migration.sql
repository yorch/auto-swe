-- CreateTable: singleton config tables for GitHub, Slack, Storage, WorkflowDefaults, GoogleOAuth
-- All sensitive fields use the same AES-256-GCM envelope as provider_credentials:
--   ciphertext (bytea) + nonce (bytea) + auth_tag (bytea) + key_version (int) + last_four (text)

CREATE TABLE "github_config" (
    "id"                               TEXT         NOT NULL DEFAULT 'default',
    "token_ciphertext"                 BYTEA,
    "token_nonce"                      BYTEA,
    "token_auth_tag"                   BYTEA,
    "token_key_version"                INTEGER,
    "token_last_four"                  TEXT,
    "webhook_secret_ciphertext"        BYTEA,
    "webhook_secret_nonce"             BYTEA,
    "webhook_secret_auth_tag"          BYTEA,
    "webhook_secret_key_version"       INTEGER,
    "webhook_secret_last_four"         TEXT,
    "oauth_client_id"                  TEXT,
    "oauth_client_secret_ciphertext"   BYTEA,
    "oauth_client_secret_nonce"        BYTEA,
    "oauth_client_secret_auth_tag"     BYTEA,
    "oauth_client_secret_key_version"  INTEGER,
    "oauth_client_secret_last_four"    TEXT,
    "base_url"                         TEXT,
    "api_url"                          TEXT,
    "updated_at"                       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "github_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "github_config_singleton" CHECK ("id" = 'default')
);

CREATE TABLE "slack_config" (
    "id"                        TEXT         NOT NULL DEFAULT 'default',
    "client_id"                 TEXT,
    "client_secret_ciphertext"  BYTEA,
    "client_secret_nonce"       BYTEA,
    "client_secret_auth_tag"    BYTEA,
    "client_secret_key_version" INTEGER,
    "client_secret_last_four"   TEXT,
    "signing_secret_ciphertext" BYTEA,
    "signing_secret_nonce"      BYTEA,
    "signing_secret_auth_tag"   BYTEA,
    "signing_secret_key_version" INTEGER,
    "signing_secret_last_four"  TEXT,
    "bot_token_ciphertext"      BYTEA,
    "bot_token_nonce"           BYTEA,
    "bot_token_auth_tag"        BYTEA,
    "bot_token_key_version"     INTEGER,
    "bot_token_last_four"       TEXT,
    "updated_at"                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "slack_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "slack_config_singleton" CHECK ("id" = 'default')
);

CREATE TABLE "storage_config" (
    "id"                                  TEXT         NOT NULL DEFAULT 'default',
    "backend"                             TEXT         NOT NULL DEFAULT 'inline',
    "s3_bucket"                           TEXT,
    "s3_region"                           TEXT,
    "s3_endpoint"                         TEXT,
    "s3_prefix"                           TEXT,
    "s3_force_path_style"                 BOOLEAN      NOT NULL DEFAULT FALSE,
    "aws_access_key_id"                   TEXT,
    "aws_secret_access_key_ciphertext"    BYTEA,
    "aws_secret_access_key_nonce"         BYTEA,
    "aws_secret_access_key_auth_tag"      BYTEA,
    "aws_secret_access_key_key_version"   INTEGER,
    "aws_secret_access_key_last_four"     TEXT,
    "updated_at"                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "storage_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_config_singleton" CHECK ("id" = 'default'),
    CONSTRAINT "storage_config_backend_check" CHECK ("backend" IN ('inline', 's3'))
);

CREATE TABLE "workflow_defaults" (
    "id"                TEXT         NOT NULL DEFAULT 'default',
    "branch_prefix"     TEXT         NOT NULL DEFAULT 'auto',
    "pr_title_template" TEXT         NOT NULL DEFAULT '[auto-swe] {{ticketId}}',
    "pr_body_template"  TEXT         NOT NULL DEFAULT '',
    "default_team_slug" TEXT         NOT NULL DEFAULT 'default',
    "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "workflow_defaults_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_defaults_singleton" CHECK ("id" = 'default')
);

CREATE TABLE "google_oauth_config" (
    "id"                        TEXT         NOT NULL DEFAULT 'default',
    "client_id"                 TEXT,
    "client_secret_ciphertext"  BYTEA,
    "client_secret_nonce"       BYTEA,
    "client_secret_auth_tag"    BYTEA,
    "client_secret_key_version" INTEGER,
    "client_secret_last_four"   TEXT,
    "updated_at"                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "google_oauth_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "google_oauth_config_singleton" CHECK ("id" = 'default')
);
