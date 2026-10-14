-- ----------------------------------------------------------------------------
-- Custom DDL that Prisma's schema DSL cannot express. Applied immediately after
-- the consolidated `20260618000000_init` baseline that the Prisma generator produced. Everything Prisma *can* express (tables, columns, standard indexes,
-- FKs — including the memory_items team/org FKs, the single-column FK covering
-- indexes, the BigInt token counters and the knowledge tables) lives in that
-- generated baseline; only the constructs below — CHECK constraints, partial
-- and expression indexes, the pgvector HNSW indexes, array NOT NULLs, the
-- knowledge scope-guard triggers and the seed row — require hand-written SQL.
--
-- The split is by *kind* of DDL, not by when it was written. While the schema is
-- undeployed the baseline is regenerated from `schema.prisma` and everything
-- non-expressible is added here; see the project skill `prisma-pgvector-hnsw`.
-- ----------------------------------------------------------------------------

-- -- pgvector HNSW indexes ----------------------------------------------------
-- Prisma 7's schema DSL cannot model HNSW/IVFFlat indexes, so they live here
-- rather than in `init`.
--
-- Routine application is `yarn db:migrate` (deploy); `prisma migrate dev`
-- cannot see HNSW indexes and will try to re-drop these on the next unrelated
-- schema change — the CI drift check lists exactly these two drops as expected.
CREATE INDEX IF NOT EXISTS "idx_memory_items_embedding" ON "memory_items"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE INDEX IF NOT EXISTS "knowledge_items_embedding_hnsw_idx" ON "knowledge_items"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- NOTE: PostgreSQL has no `ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS`. Each
-- CHECK constraint below is wrapped in a DO block that swallows
-- `duplicate_object`, so the script is safe to replay from the top after an
-- operator has resolved an interrupted deployment (`prisma migrate resolve`),
-- rather than failing on the object it already created.
--
-- What that guard is not: `prisma migrate deploy` does not retry a failed
-- migration by itself — it refuses to proceed while one is recorded as failed —
-- and the wrapper only matches on the *name*, so an object already present under
-- one of these names is kept whatever its definition. This is replay tolerance
-- for this script alone, never a repair for a database someone has edited by
-- hand. `CREATE [UNIQUE] INDEX IF NOT EXISTS` is natively supported and needs no
-- wrapper. The triggers below guard themselves with `DROP TRIGGER IF EXISTS`.

-- -- Provider credentials (GLOBAL, ORGANIZATION, or TEAM; no template scope) --
DO $$ BEGIN
  ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_check"
    CHECK ("scope" IN ('GLOBAL', 'ORGANIZATION', 'TEAM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_global_unique"
    ON "provider_credentials" ("provider")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_org_unique"
    ON "provider_credentials" ("provider", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_team_unique"
    ON "provider_credentials" ("provider", "team_id")
    WHERE "scope" = 'TEAM';

DO $$ BEGIN
  ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Skills: same scope-discriminator rule as provider credentials -------------
-- Skills are GLOBAL platform content or owned by one tenant. Without this a
-- GLOBAL row could carry a team_id and leak into that tenant's filtered view,
-- and a TEAM row could exist with no owner to filter on.
DO $$ BEGIN
  ALTER TABLE "skills"
    ADD CONSTRAINT "skills_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Skill sources: scope-discriminator rule + one source per place per scope --
-- Same tenancy rule as `skills`: a GLOBAL source carries no owner, a TEAM/ORG
-- one carries exactly its own.
DO $$ BEGIN
  ALTER TABLE "skill_sources"
    ADD CONSTRAINT "skill_sources_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND "org_id" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A repository location (host, owner, repo, subdirectory) is imported once per
-- scope: a second source over the same place would install the same skill names
-- twice. `ref` is deliberately not part of the key — two refs of one location
-- produce the same names, and the way to move a source is to update it. The
-- nullable owner columns need one partial index per scope, because NULLs are
-- distinct in a unique index (the Agent library's pattern). Prisma cannot
-- express `WHERE scope = …`.
CREATE UNIQUE INDEX IF NOT EXISTS "skill_sources_location_global_uidx"
    ON "skill_sources" ("host", "owner", "repo", "path")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX IF NOT EXISTS "skill_sources_location_org_uidx"
    ON "skill_sources" ("host", "owner", "repo", "path", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX IF NOT EXISTS "skill_sources_location_team_uidx"
    ON "skill_sources" ("host", "owner", "repo", "path", "team_id")
    WHERE "scope" = 'TEAM';

-- -- Connections: git_repo identity uniqueness (partial) ----------------------
-- A git_repo connection is identified by (host, owner, name). org/repo are
-- nullable so non-git connection types (e.g. `mcp`) need not set them;
-- uniqueness applies only to git_repo rows. The host is the web base override,
-- normalised by the application to an origin, with NULL meaning the instance's
-- own host: `acme/api` on github.com and on a GitHub Enterprise server are
-- different repositories. GitHub compares owner and name case-insensitively, so
-- the index does too. Partial and expression-based, so Prisma can't express it.
CREATE UNIQUE INDEX IF NOT EXISTS "connections_git_repo_host_org_repo_ci_uidx"
    ON "connections" (COALESCE("github_url", ''), lower("organization_name"), lower("repo_name"))
    WHERE "type" = 'git_repo';

-- -- Agent library: one row per (key, version) at a scope ----------------------
-- Partial uniques per scope; Prisma can't express `WHERE scope = …`. Postgres
-- treats NULL discriminators as distinct, so each WHERE scopes its uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "agents_key_version_global_uidx"
    ON "agents" ("key", "version")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX IF NOT EXISTS "agents_key_version_org_uidx"
    ON "agents" ("key", "version", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX IF NOT EXISTS "agents_key_version_team_uidx"
    ON "agents" ("key", "version", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX IF NOT EXISTS "agents_key_version_channel_uidx"
    ON "agents" ("key", "version", "channel_id")
    WHERE "scope" = 'CHANNEL';

CREATE UNIQUE INDEX IF NOT EXISTS "agents_key_version_template_uidx"
    ON "agents" ("key", "version", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- Agent scope/discriminator integrity: the scope discriminator column must be
-- non-null and every other scope column null. Mirrors
-- `provider_credentials_scope_keys_check`, extended to all five agent scopes.
-- Complements the partial uniques above (which, because Postgres treats NULL
-- discriminators as distinct, could otherwise admit multiple mis-scoped rows).
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An Agent version's runtime is one of `IMPLEMENTER_RUNTIMES` (`types/api.ts`) or null
-- (no opinion). The worker refuses an unknown value too; this keeps a row the
-- API never wrote (a hand edit, a future bundle) from reaching it at all.
DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_runtime_check"
    CHECK ("runtime" IS NULL OR "runtime" IN ('mastra', 'claude-code', 'pi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- How hard an Agent version's model reasons before it answers (`REASONING_LEVELS`,
-- `types/api.ts`), or null for no opinion. Same reasoning as the runtime above: an
-- unrecognised value would reach a provider adapter as an option it does not know.
DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_reasoning_check"
    CHECK ("reasoning" IS NULL OR "reasoning" IN ('off', 'low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- HITL idempotency ---------------------------------------------------------
-- Prevents duplicate PENDING rows for the same (run_id, node_id) pair while
-- allowing multiple historical resolved/cancelled rows (retry loops).
CREATE UNIQUE INDEX IF NOT EXISTS workflow_human_steps_pending_unique
  ON workflow_human_steps (run_id, node_id)
  WHERE status = 'PENDING';

-- -- Pull requests: one row per (repo_id, pr_number) (partial) -----------------
-- pr_number is nullable (the row is created before the PR number is known), so
-- the uniqueness applies only once it's set. Prisma can't express a partial
-- `@@unique`. NOTE: fails to apply if duplicate (repo_id, pr_number) rows
-- already exist — fine on a clean/consolidated-baseline DB.
CREATE UNIQUE INDEX IF NOT EXISTS "pull_requests_repo_id_pr_number_uidx"
    ON "pull_requests" ("repo_id", "pr_number")
    WHERE "pr_number" IS NOT NULL;

-- -- Singleton system-config tables -------------------------------------------
-- The `id` column must always be the literal 'default'. The Prisma models use
-- `@default("default")` so client writes always produce the right value; these
-- checks are belt-and-suspenders against raw SQL inserts.
DO $$ BEGIN
  ALTER TABLE "github_config"
    ADD CONSTRAINT "github_config_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "slack_config"
    ADD CONSTRAINT "slack_config_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- CI-wait strategy. All four columns are nullable: NULL means "not configured
-- in the DB", so the resolver falls back to CI_WAIT_MODE / CI_POLL_*. Reject a
-- typo here rather than silently degrading to 'signal', and reject a
-- non-positive interval, which would busy-loop the CI poller.
DO $$ BEGIN
  ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_ci_wait_mode_check"
    CHECK ("ci_wait_mode" IS NULL OR "ci_wait_mode" IN ('signal', 'poll'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_ci_poll_positive_check"
    CHECK (
        ("ci_poll_interval_sec" IS NULL OR "ci_poll_interval_sec" > 0)
        AND ("ci_poll_grace_sec"    IS NULL OR "ci_poll_grace_sec"    > 0)
        AND ("ci_poll_deadline_sec" IS NULL OR "ci_poll_deadline_sec" > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "embedding_configs"
    ADD CONSTRAINT "embedding_configs_singleton_check" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "issue_tracker_config"
    ADD CONSTRAINT "issue_tracker_config_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "knowledge_base_config"
    ADD CONSTRAINT "knowledge_base_config_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "figma_config"
    ADD CONSTRAINT "figma_config_singleton" CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Config registry: scope discriminator + per-scope uniqueness ---------------
-- Same shape as `agents` above: exactly the id column for the row's own scope
-- may be set, so a TEAM override can never also carry an org id.
DO $$ BEGIN
  ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One override per key per scope instance. Partial per scope because Prisma
-- cannot express `WHERE scope = …` in a unique index — the same reason writes
-- use findFirst-then-create instead of upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_global_uidx"
    ON "config_settings" ("key")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_org_uidx"
    ON "config_settings" ("key", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_team_uidx"
    ON "config_settings" ("key", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_channel_uidx"
    ON "config_settings" ("key", "channel_id")
    WHERE "scope" = 'CHANNEL';

CREATE UNIQUE INDEX IF NOT EXISTS "config_settings_template_uidx"
    ON "config_settings" ("key", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- -- Config permissions: one grantee, tenant-level scopes only -----------------
-- A grant names exactly one grantee: a specific user, or every holder of a role.
DO $$ BEGIN
  ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_grantee_check" CHECK (
    ("user_id" IS NOT NULL AND "role" IS NULL)
 OR ("user_id" IS NULL AND "role" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Grants are only meaningful down to a tenant boundary: a CHANNEL- or
-- TEMPLATE-scoped grant would be narrower than the thing an operator actually
-- administers, so authority is expressed at GLOBAL, ORGANIZATION, or TEAM and
-- covers everything beneath it. `ConfigScope` also permits CHANNEL and
-- WORKFLOW_TEMPLATE, so a row carrying either fails every branch and is
-- rejected.
DO $$ BEGIN
  ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'       AND "team_id" IS NULL AND "org_id" IS NULL)
 OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
 OR ("scope" = 'TEAM'         AND "team_id" IS NOT NULL AND "org_id" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One grant per (pattern, grantee, scope instance) so re-granting is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_user_global_uidx"
    ON "config_permissions" ("key_pattern", "user_id")
    WHERE "scope" = 'GLOBAL' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_role_global_uidx"
    ON "config_permissions" ("key_pattern", "role")
    WHERE "scope" = 'GLOBAL' AND "role" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_user_org_uidx"
    ON "config_permissions" ("key_pattern", "user_id", "org_id")
    WHERE "scope" = 'ORGANIZATION' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_role_org_uidx"
    ON "config_permissions" ("key_pattern", "role", "org_id")
    WHERE "scope" = 'ORGANIZATION' AND "role" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_user_team_uidx"
    ON "config_permissions" ("key_pattern", "user_id", "team_id")
    WHERE "scope" = 'TEAM' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "config_permissions_role_team_uidx"
    ON "config_permissions" ("key_pattern", "role", "team_id")
    WHERE "scope" = 'TEAM' AND "role" IS NOT NULL;

-- -- API tokens: exactly one owner --------------------------------------------
-- A token belongs to exactly one owner: a user, or a service principal. Neither
-- is a token nobody can revoke from their own settings and nothing cascades
-- away; both would be a token that authenticates as a person and a machine at
-- once. Prisma cannot express a CHECK spanning two columns.
DO $$ BEGIN
  ALTER TABLE "api_tokens"
    ADD CONSTRAINT "api_tokens_exactly_one_owner"
    CHECK (num_nonnulls("user_id", "service_principal_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Service principals: positive limits ---------------------------------------
-- Zero would be a disabled principal by another name, and `disabled_at` is the
-- one switch for that.
DO $$ BEGIN
  ALTER TABLE "service_principals"
    ADD CONSTRAINT "service_principals_limits_positive"
    CHECK ("max_runs_per_day" >= 1 AND "max_in_flight" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Automations: per-source filter shape ---------------------------------------
-- A source this build does not know is never stored, and each source's filters
-- keep the invariants the original CI-trigger columns had: lists that are never
-- empty (an empty list reads as "match nothing" in code but "match everything"
-- to a person) and only known events.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
    CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_filters_object"
    CHECK (jsonb_typeof("filters") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_inputs_object"
    CHECK (jsonb_typeof("inputs") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A CHECK that evaluates to NULL passes, and every term below is NULL when its key is missing;
-- COALESCE makes a missing list fail the check instead of passing it.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_workflow_run_failed_filters"
    CHECK ("source" <> 'github.workflow_run.failed' OR COALESCE(
      "filters" ?& ARRAY['events', 'branchPatterns', 'workflowPatterns']
      AND jsonb_typeof("filters"->'events') = 'array'
      AND jsonb_typeof("filters"->'branchPatterns') = 'array'
      AND jsonb_typeof("filters"->'workflowPatterns') = 'array'
      AND jsonb_array_length("filters"->'events') > 0
      AND ("filters"->'events') <@ '["push", "pull_request", "schedule"]'::jsonb
      AND jsonb_array_length("filters"->'branchPatterns') > 0
      AND jsonb_array_length("filters"->'workflowPatterns') > 0,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_issues_labeled_filters"
    CHECK ("source" <> 'github.issues.labeled' OR COALESCE(
      "filters" ? 'labels'
      AND jsonb_typeof("filters"->'labels') = 'array'
      AND jsonb_array_length("filters"->'labels') > 0,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The `inbound.event` source: its automations belong to a team, name an endpoint
-- and at least one event-type pattern, and keep their rules and field mapping as
-- a list and an object. Like the check above, COALESCE makes a missing key fail
-- instead of passing as NULL.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_inbound_event_filters"
    CHECK ("source" <> 'inbound.event' OR COALESCE(
      "team_id" IS NOT NULL
      AND "connection_id" IS NULL
      AND "filters" ?& ARRAY['endpointId', 'eventTypes', 'match', 'fields']
      AND jsonb_typeof("filters"->'endpointId') = 'string'
      AND jsonb_typeof("filters"->'eventTypes') = 'array'
      AND jsonb_array_length("filters"->'eventTypes') > 0
      AND jsonb_typeof("filters"->'match') = 'array'
      AND jsonb_typeof("filters"->'fields') = 'object',
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A trigger's bounds. `cooldown_minutes` 0 means "no cooldown"; a run ceiling of
-- 0 would make the automation permanently inert, hence the floor of 1.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_bounds"
    CHECK ("cooldown_minutes" BETWEEN 0 AND 10080 AND "max_runs_per_day" BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every automation belongs to something that manages it.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_present"
    CHECK ("connection_id" IS NOT NULL OR "team_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Only a team automation names the repository its runs act on; a repository's
-- automation acts on its own repository.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_target_connection_team_only"
    CHECK ("target_connection_id" IS NULL OR ("connection_id" IS NULL AND "team_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The retention sweep reads decisions that started no run, oldest first. Partial, so the
-- started decisions the guards read (kept for good) do not grow it.
CREATE INDEX IF NOT EXISTS "automation_fires_prunable_created_at_idx"
  ON "automation_fires" ("created_at") WHERE "outcome" <> 'STARTED';

-- -- Inbound events: one known endpoint shape per row --------------------------
-- An endpoint's configuration is one of the known shapes: a scheme that names its
-- own header has one, HMAC says how it is encoded, and the pointers are pointers.
-- These are cross-column implications, so no single-column type can carry them.
DO $$ BEGIN
  ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_scheme_check"
    CHECK (
      "scheme" IN ('autoswe-v1', 'hmac-sha256', 'shared-secret-header')
      AND ("scheme" = 'autoswe-v1' OR "signature_header" IS NOT NULL)
      AND (("scheme" = 'hmac-sha256') = ("signature_encoding" IS NOT NULL))
      AND ("signature_encoding" IS NULL OR "signature_encoding" IN ('hex', 'base64'))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_format_check"
    CHECK ("format" IN ('json', 'cloudevents'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_pointers_check"
    CHECK (
      ("type_pointer" = '' OR "type_pointer" LIKE '/%')
      AND ("id_pointer" IS NULL OR "id_pointer" = '' OR "id_pointer" LIKE '/%')
      AND ("subject_pointer" IS NULL OR "subject_pointer" = '' OR "subject_pointer" LIKE '/%')
      AND ("scope_pointer" IS NULL OR "scope_pointer" = '' OR "scope_pointer" LIKE '/%')
      AND ("time_pointer" IS NULL OR "time_pointer" = '' OR "time_pointer" LIKE '/%')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A previous secret is its whole envelope plus an expiry, or nothing: without an
-- expiry it would be accepted forever. The live secret is NOT NULL, so it needs
-- no equivalent check.
DO $$ BEGIN
  ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_previous_secret_check"
    CHECK (
      ("previous_secret_ciphertext" IS NULL) = ("previous_secret_nonce" IS NULL)
      AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_auth_tag" IS NULL)
      AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_key_version" IS NULL)
      AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_expires_at" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Signed template webhooks: a secret is its whole envelope or nothing -------
-- The ciphertext, nonce and auth tag are one AES-256-GCM envelope, and
-- `key_version` names the key that can open it, so it moves with them: a partial
-- envelope cannot be decrypted, and a version without a ciphertext says nothing.
-- The previous secret is the same envelope plus the expiry that bounds how long
-- it is still accepted — without one it would be accepted forever.
-- `last_four` is display-only and deliberately independent of the envelope.
DO $$ BEGIN
  ALTER TABLE "workflow_templates"
    ADD CONSTRAINT "workflow_templates_webhook_signing_secret_check"
    CHECK (
      ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_nonce" IS NULL)
      AND ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_auth_tag" IS NULL)
      AND ("webhook_signing_secret_ciphertext" IS NULL) = ("webhook_signing_secret_key_version" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "workflow_templates"
    ADD CONSTRAINT "workflow_templates_webhook_previous_signing_secret_check"
    CHECK (
      ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_nonce" IS NULL)
      AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_auth_tag" IS NULL)
      AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_key_version" IS NULL)
      AND ("webhook_previous_signing_secret_ciphertext" IS NULL) = ("webhook_previous_signing_secret_expires_at" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Run callbacks: subscriptions, envelopes and delivery invariants ----------
-- An endpoint subscribes to at least one known event, and a path prefix is
-- absolute. `cardinality(...) >= 1` rather than a NOT NULL: the array is
-- non-null below, but an empty subscription list would silently match nothing
-- while looking configured.
--
-- The `events` NOT NULL is hand-written for the same reason as every other array
-- column here: Prisma 7 emits `String[]` as nullable at the DB level.
UPDATE "callback_endpoints" SET "events" = ARRAY[]::TEXT[] WHERE "events" IS NULL;
ALTER TABLE "callback_endpoints"
  ALTER COLUMN "events" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "callback_endpoints"
    ADD CONSTRAINT "callback_endpoints_events_check"
    CHECK (
      cardinality("events") >= 1
      AND "events" <@ ARRAY['run.completed', 'run.waiting_for_human']::TEXT[]
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A previous secret is its whole envelope with an expiry, or nothing: a partial
-- one cannot be decrypted, and one without an expiry would sign deliveries
-- forever. The live secret is NOT NULL, so it needs no equivalent check.
DO $$ BEGIN
  ALTER TABLE "callback_endpoints"
    ADD CONSTRAINT "callback_endpoints_previous_signing_secret_check"
    CHECK (
      ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_nonce" IS NULL)
      AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_auth_tag" IS NULL)
      AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_key_version" IS NULL)
      AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_expires_at" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A callback URL's path is matched against this prefix on a segment boundary, so
-- it has to be absolute.
DO $$ BEGIN
  ALTER TABLE "callback_endpoints"
    ADD CONSTRAINT "callback_endpoints_path_prefix_check"
    CHECK (left("path_prefix", 1) = '/');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "outbound_deliveries"
    ADD CONSTRAINT "outbound_deliveries_event_check"
    CHECK ("event" IN ('run.completed', 'run.waiting_for_human'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "outbound_deliveries"
    ADD CONSTRAINT "outbound_deliveries_attempts_check" CHECK ("attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Who launched the run, as every payload reports it: a known kind and a
-- non-empty id.
DO $$ BEGIN
  ALTER TABLE "run_callbacks"
    ADD CONSTRAINT "run_callbacks_launched_by_check"
    CHECK (
      jsonb_typeof("launched_by") = 'object'
      AND "launched_by"->>'kind' IN ('user', 'service_principal', 'template_webhook', 'automation')
      AND coalesce("launched_by"->>'id', '') <> ''
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Governed knowledge: version and approval shape ----------------------------
-- `approved_version` is the version the current APPROVED status refers to, so it
-- must equal `version` and carry the approving actor and timestamp; a row that is
-- not APPROVED must carry none of them, or an approval survives a status change.
DO $$ BEGIN
  ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_version_positive"
    CHECK ("version" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_approval_version_check"
    CHECK (
      ("status" = 'APPROVED' AND "approved_version" IS NOT NULL AND "approved_version" = "version" AND "approved_at" IS NOT NULL)
      OR ("status" <> 'APPROVED' AND "approved_version" IS NULL AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Trusted knowledge evidence: only gates this build records -----------------
DO $$ BEGIN
  ALTER TABLE "trusted_knowledge_evidence"
    ADD CONSTRAINT "trusted_knowledge_evidence_attempt_positive" CHECK ("step_attempt" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "trusted_knowledge_evidence"
    ADD CONSTRAINT "trusted_knowledge_evidence_activity_attempt_positive" CHECK ("activity_attempt" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "trusted_knowledge_evidence"
    ADD CONSTRAINT "trusted_knowledge_evidence_gate_name_check"
    CHECK ("gate_name" IN ('runLint', 'runTypecheck', 'runTests', 'runBuild', 'runVulnScan', 'runPerfBench'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Repo dependency graph -----------------------------------------------------
-- The repo_dependencies edge table and connections.package_names live in the
-- generated baseline; only these constructs need hand-written SQL.

-- Resolved edges: one per (from, to, kind, source). Suggestions carry a null
-- to_repo_id and Postgres treats NULLs as distinct, so a plain unique would let
-- duplicate suggestions through — scope real-edge uniqueness with a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "repo_dependencies_resolved_uidx"
  ON "repo_dependencies" ("from_repo_id", "to_repo_id", "kind", "source")
  WHERE "to_repo_id" IS NOT NULL;

-- Unresolved suggestions: one per (from, to_ref, kind, source).
CREATE UNIQUE INDEX IF NOT EXISTS "repo_dependencies_suggestion_uidx"
  ON "repo_dependencies" ("from_repo_id", "to_ref", "kind", "source")
  WHERE "to_repo_id" IS NULL;

-- A row points at a repo or names an unresolved ref, never neither.
DO $$ BEGIN
  ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_target_shape_check"
    CHECK ("to_repo_id" IS NOT NULL OR "to_ref" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No self-edges (holds trivially when to_repo_id is null).
DO $$ BEGIN
  ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_no_self_edge_check"
    CHECK ("to_repo_id" IS NULL OR "from_repo_id" <> "to_repo_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Status / source enums kept as TEXT with a CHECK, per the enum→string house style.
DO $$ BEGIN
  ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_status_check"
    CHECK ("status" IN ('active', 'proposed', 'dismissed', 'unresolved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "repo_dependencies"
    ADD CONSTRAINT "repo_dependencies_source_check"
    CHECK ("source" IN ('manual', 'manifest', 'git_signal', 'inferred'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Autonomy policies: one default per scope, one row per template ------------
CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_global_default_key"
    ON "autonomy_policies" ("is_default") WHERE "is_default" = true AND "team_id" IS NULL AND "template_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_team_default_key"
    ON "autonomy_policies" ("team_id") WHERE "is_default" = true AND "template_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_template_key"
    ON "autonomy_policies" ("template_id") WHERE "template_id" IS NOT NULL;

-- -- Human error baselines: a rate in [0, 1] over a non-negative sample ---------
DO $$ BEGIN
  ALTER TABLE "human_error_baselines"
    ADD CONSTRAINT "human_error_baselines_sample_size_check" CHECK ("sample_size" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "human_error_baselines"
    ADD CONSTRAINT "human_error_baselines_error_count_check" CHECK ("error_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "human_error_baselines"
    ADD CONSTRAINT "human_error_baselines_error_rate_check" CHECK ("error_rate" >= 0 AND "error_rate" <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The run reaper's candidate query and `orgMonthSpend` both read only the runs
-- that never ended; this keeps that set cheap however many finished runs the
-- table holds. Partial and NULLS FIRST, so Prisma's DSL cannot express it. The
-- order matches the reaper's: never-checked first, then oldest.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_unfinalized_reap"
    ON "workflow_runs" ("reap_checked_at" NULLS FIRST, "started_at") WHERE "ended_at" IS NULL;

-- -- NOT NULL on array columns -------------------------------------------------
-- Prisma 7's generator emits `String[]` columns as nullable at the DB level
-- even though the client treats them as always-non-null — reinstate the
-- DB-level constraint. (Coalesce first so a stray NULL can't block the ALTER.)
UPDATE "teams" SET "egress_allowlist" = ARRAY[]::TEXT[] WHERE "egress_allowlist" IS NULL;
ALTER TABLE "teams"
  ALTER COLUMN "egress_allowlist" SET NOT NULL;

UPDATE "teams" SET "shell_image_allowlist" = ARRAY[]::TEXT[] WHERE "shell_image_allowlist" IS NULL;
ALTER TABLE "teams"
  ALTER COLUMN "shell_image_allowlist" SET NOT NULL;

UPDATE "workflow_shell_audit" SET "egress_allowlist_snapshot" = ARRAY[]::TEXT[] WHERE "egress_allowlist_snapshot" IS NULL;
ALTER TABLE "workflow_shell_audit"
  ALTER COLUMN "egress_allowlist_snapshot" SET NOT NULL;

UPDATE "memory_items" SET "skills_active" = ARRAY[]::TEXT[] WHERE "skills_active" IS NULL;
ALTER TABLE "memory_items"
  ALTER COLUMN "skills_active" SET NOT NULL;

UPDATE "context_snapshots" SET "success_criteria" = ARRAY[]::TEXT[] WHERE "success_criteria" IS NULL;
ALTER TABLE "context_snapshots"
  ALTER COLUMN "success_criteria" SET NOT NULL;

UPDATE "eval_cases" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
ALTER TABLE "eval_cases"
  ALTER COLUMN "tags" SET NOT NULL;

UPDATE "knowledge_base_config" SET "spaces" = ARRAY[]::TEXT[] WHERE "spaces" IS NULL;
ALTER TABLE "knowledge_base_config"
  ALTER COLUMN "spaces" SET NOT NULL;

UPDATE "knowledge_items" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
ALTER TABLE "knowledge_items"
  ALTER COLUMN "tags" SET NOT NULL;

UPDATE "connections" SET "package_names" = ARRAY[]::TEXT[] WHERE "package_names" IS NULL;
ALTER TABLE "connections"
  ALTER COLUMN "package_names" SET NOT NULL;

-- A service principal's allow-lists are NOT NULL: an absent list would read as
-- "nothing allowed" in one place and as "unknown" in another. The empty list is
-- the one spelling of "nothing".
UPDATE "service_principals" SET "connection_ids" = ARRAY[]::UUID[] WHERE "connection_ids" IS NULL;
ALTER TABLE "service_principals"
  ALTER COLUMN "connection_ids" SET NOT NULL;

UPDATE "service_principals" SET "template_ids" = ARRAY[]::UUID[] WHERE "template_ids" IS NULL;
ALTER TABLE "service_principals"
  ALTER COLUMN "template_ids" SET NOT NULL;

UPDATE "api_tokens" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "api_tokens"
  ALTER COLUMN "scopes" SET NOT NULL;

-- OAuth provider (better-auth `@better-auth/oauth-provider`). Only the arrays the
-- plugin itself requires are NOT NULL: redirect URIs on a client and granted
-- scopes on a token or consent. Every other array column stays nullable on
-- purpose — the plugin distinguishes NULL from an empty array (a resource's
-- `allowed_scopes` NULL means unrestricted, `{}` means nothing allowed), so a
-- blanket NOT NULL would break the boot-time resource seed or silently turn the
-- resource into deny-all.
UPDATE "oauth_clients" SET "redirect_uris" = ARRAY[]::TEXT[] WHERE "redirect_uris" IS NULL;
ALTER TABLE "oauth_clients"
  ALTER COLUMN "redirect_uris" SET NOT NULL;

UPDATE "oauth_access_tokens" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "oauth_access_tokens"
  ALTER COLUMN "scopes" SET NOT NULL;

UPDATE "oauth_refresh_tokens" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "oauth_refresh_tokens"
  ALTER COLUMN "scopes" SET NOT NULL;

UPDATE "oauth_consents" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "oauth_consents"
  ALTER COLUMN "scopes" SET NOT NULL;

-- -- Governed knowledge: scope guards ------------------------------------------
-- The denormalized tenant and source fields are part of the ACL. Enforce their
-- consistency in the database so a malformed writer cannot create cross-org grants.
-- A row-level trigger is the only construct that can read the referenced teams
-- and the repository's owner, which no CHECK can do.
CREATE OR REPLACE FUNCTION enforce_knowledge_item_scope() RETURNS trigger AS $$
DECLARE
  owner_org UUID;
  origin_org UUID;
  repository_team UUID;
BEGIN
  SELECT "org_id" INTO owner_org FROM "teams" WHERE "id" = NEW."owner_team_id";
  SELECT "org_id" INTO origin_org FROM "teams" WHERE "id" = NEW."origin_team_id";
  IF owner_org IS DISTINCT FROM NEW."org_id" OR origin_org IS DISTINCT FROM NEW."org_id" THEN
    RAISE EXCEPTION 'knowledge item owner, origin and organization must share one organization';
  END IF;
  IF NEW."repo_id" IS NOT NULL THEN
    SELECT "team_id" INTO repository_team FROM "connections" WHERE "id" = NEW."repo_id";
    IF repository_team IS DISTINCT FROM NEW."origin_team_id" THEN
      RAISE EXCEPTION 'knowledge repository must belong to its origin team';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "knowledge_items_scope_guard" ON "knowledge_items";
CREATE TRIGGER "knowledge_items_scope_guard"
  BEFORE INSERT OR UPDATE OF "owner_team_id", "origin_team_id", "org_id", "repo_id"
  ON "knowledge_items" FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_item_scope();

CREATE OR REPLACE FUNCTION enforce_knowledge_grant_scope() RETURNS trigger AS $$
DECLARE
  item_org UUID;
  recipient_org UUID;
BEGIN
  SELECT "org_id" INTO item_org FROM "knowledge_items" WHERE "id" = NEW."knowledge_item_id";
  SELECT "org_id" INTO recipient_org FROM "teams" WHERE "id" = NEW."team_id";
  IF item_org IS NULL OR item_org IS DISTINCT FROM recipient_org THEN
    RAISE EXCEPTION 'selected knowledge recipient must belong to the item organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "knowledge_item_team_grants_scope_guard" ON "knowledge_item_team_grants";
CREATE TRIGGER "knowledge_item_team_grants_scope_guard"
  BEFORE INSERT OR UPDATE OF "knowledge_item_id", "team_id"
  ON "knowledge_item_team_grants" FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_grant_scope();

-- -- Seeds ---------------------------------------------------------------------
-- Default embedding config so the worker can resolve a spec before the admin
-- visits the dashboard. Overridable via /admin/model-config.
INSERT INTO "embedding_configs" ("id", "model_spec")
VALUES ('default', 'openai/text-embedding-3-large')
ON CONFLICT ("id") DO NOTHING;
