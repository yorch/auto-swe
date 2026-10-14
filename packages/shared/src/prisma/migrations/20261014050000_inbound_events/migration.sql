-- Event endpoints: team-owned URLs other services post signed events to, and the `inbound.event`
-- automation source that decides what each event starts (docs/inbound-events.md).

-- CreateTable
CREATE TABLE "event_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheme" TEXT NOT NULL,
    "signature_header" TEXT,
    "signature_prefix" TEXT,
    "signature_encoding" TEXT,
    "format" TEXT NOT NULL DEFAULT 'json',
    "type_pointer" TEXT NOT NULL,
    "id_pointer" TEXT,
    "subject_pointer" TEXT,
    "scope_pointer" TEXT,
    "time_pointer" TEXT,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_nonce" BYTEA NOT NULL,
    "secret_auth_tag" BYTEA NOT NULL,
    "secret_key_version" INTEGER NOT NULL,
    "secret_last_four" TEXT NOT NULL,
    "previous_secret_ciphertext" BYTEA,
    "previous_secret_nonce" BYTEA,
    "previous_secret_auth_tag" BYTEA,
    "previous_secret_key_version" INTEGER,
    "previous_secret_last_four" TEXT,
    "previous_secret_expires_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "event_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_endpoints_team_id_idx" ON "event_endpoints"("team_id");

-- CreateIndex
CREATE INDEX "event_endpoints_created_by_id_idx" ON "event_endpoints"("created_by_id");

-- AddForeignKey
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A team automation may name the repository its runs act on. It stays the team's: the owner of
-- an automation is still its `connection_id` (a repository's) or else its `team_id`.
ALTER TABLE "automations" ADD COLUMN "target_connection_id" UUID;

-- CreateIndex
CREATE INDEX "automations_target_connection_id_idx" ON "automations"("target_connection_id");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_target_connection_id_fkey" FOREIGN KEY ("target_connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: DDL the Prisma schema cannot express (see the prisma-pgvector-hnsw skill).

-- Only a team automation names a target repository; a repository's acts on its own.
ALTER TABLE "automations" ADD CONSTRAINT "automations_target_connection_team_only"
  CHECK ("target_connection_id" IS NULL OR ("connection_id" IS NULL AND "team_id" IS NOT NULL));

-- The third source. Its automations belong to a team, name an endpoint and at least one event
-- type pattern, and keep their rules and field mapping as a list and an object. COALESCE makes a
-- missing key fail the check instead of passing it as NULL.
ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
  CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event'));
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

-- An endpoint's configuration is one of the known shapes: a scheme that names its header has
-- one, an HMAC says how it is encoded, and the pointers are pointers ('' or '/…').
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_scheme_check"
  CHECK (
    "scheme" IN ('autoswe-v1', 'hmac-sha256', 'shared-secret-header')
    AND ("scheme" = 'autoswe-v1' OR "signature_header" IS NOT NULL)
    AND (("scheme" = 'hmac-sha256') = ("signature_encoding" IS NOT NULL))
    AND ("signature_encoding" IS NULL OR "signature_encoding" IN ('hex', 'base64'))
  );
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_format_check"
  CHECK ("format" IN ('json', 'cloudevents'));
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_pointers_check"
  CHECK (
    ("type_pointer" = '' OR "type_pointer" LIKE '/%')
    AND ("id_pointer" IS NULL OR "id_pointer" = '' OR "id_pointer" LIKE '/%')
    AND ("subject_pointer" IS NULL OR "subject_pointer" = '' OR "subject_pointer" LIKE '/%')
    AND ("scope_pointer" IS NULL OR "scope_pointer" = '' OR "scope_pointer" LIKE '/%')
    AND ("time_pointer" IS NULL OR "time_pointer" = '' OR "time_pointer" LIKE '/%')
  );
-- A previous secret is its whole envelope and an expiry, or nothing: without an expiry it would
-- be accepted forever.
ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_previous_secret_check"
  CHECK (
    ("previous_secret_ciphertext" IS NULL) = ("previous_secret_nonce" IS NULL)
    AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_auth_tag" IS NULL)
    AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_key_version" IS NULL)
    AND ("previous_secret_ciphertext" IS NULL) = ("previous_secret_expires_at" IS NULL)
  );
