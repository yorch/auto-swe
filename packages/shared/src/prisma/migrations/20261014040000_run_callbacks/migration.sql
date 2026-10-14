-- Run callbacks (docs/run-callbacks.md): team-registered receivers, the callback a launch asked
-- for, and the outbox of signed deliveries the delivery sweep sends.

-- CreateEnum
CREATE TYPE "OutboundDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'DEAD');

-- CreateTable
CREATE TABLE "callback_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "path_prefix" TEXT NOT NULL DEFAULT '/',
    "events" TEXT[],
    "allow_private_network" BOOLEAN NOT NULL DEFAULT false,
    "accept_template_webhook_launches" BOOLEAN NOT NULL DEFAULT false,
    "signing_secret_ciphertext" BYTEA NOT NULL,
    "signing_secret_nonce" BYTEA NOT NULL,
    "signing_secret_auth_tag" BYTEA NOT NULL,
    "signing_secret_key_version" INTEGER NOT NULL,
    "signing_secret_last_four" TEXT NOT NULL,
    "previous_signing_secret_ciphertext" BYTEA,
    "previous_signing_secret_nonce" BYTEA,
    "previous_signing_secret_auth_tag" BYTEA,
    "previous_signing_secret_key_version" INTEGER,
    "previous_signing_secret_last_four" TEXT,
    "previous_signing_secret_expires_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "callback_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_callbacks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_input_id" UUID NOT NULL,
    "endpoint_id" UUID,
    "workflow_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "url_ciphertext" BYTEA NOT NULL,
    "url_nonce" BYTEA NOT NULL,
    "url_auth_tag" BYTEA NOT NULL,
    "url_key_version" INTEGER NOT NULL,
    "context" JSONB,
    "launched_by" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "endpoint_id" UUID,
    "run_callback_id" UUID,
    "workflow_run_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_window_started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ,
    "claim_token" UUID,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "dead_reason" TEXT,
    "delivered_at" TIMESTAMPTZ,
    "dead_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "callback_endpoints_created_by_id_idx" ON "callback_endpoints"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "callback_endpoints_team_id_name_key" ON "callback_endpoints"("team_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "run_callbacks_run_input_id_key" ON "run_callbacks"("run_input_id");

-- CreateIndex
CREATE INDEX "run_callbacks_endpoint_id_idx" ON "run_callbacks"("endpoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_deliveries_dedupe_key_key" ON "outbound_deliveries"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbound_deliveries_status_next_attempt_at_idx" ON "outbound_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbound_deliveries_status_created_at_idx" ON "outbound_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbound_deliveries_endpoint_id_created_at_idx" ON "outbound_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_deliveries_workflow_run_id_idx" ON "outbound_deliveries"("workflow_run_id");

-- CreateIndex
CREATE INDEX "outbound_deliveries_run_callback_id_idx" ON "outbound_deliveries"("run_callback_id");

-- AddForeignKey
ALTER TABLE "callback_endpoints" ADD CONSTRAINT "callback_endpoints_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callback_endpoints" ADD CONSTRAINT "callback_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_callbacks" ADD CONSTRAINT "run_callbacks_run_input_id_fkey" FOREIGN KEY ("run_input_id") REFERENCES "run_inputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_callbacks" ADD CONSTRAINT "run_callbacks_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "callback_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "callback_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_run_callback_id_fkey" FOREIGN KEY ("run_callback_id") REFERENCES "run_callbacks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Prisma's DSL cannot express (.claude/skills/prisma-pgvector-hnsw).

-- An endpoint subscribes to at least one known event, and the list is never NULL.
ALTER TABLE "callback_endpoints"
  ALTER COLUMN "events" SET NOT NULL;
ALTER TABLE "callback_endpoints"
  ADD CONSTRAINT "callback_endpoints_events_check"
  CHECK (
    cardinality("events") >= 1
    AND "events" <@ ARRAY['run.completed', 'run.waiting_for_human']::TEXT[]
  ),
  -- A previous secret is its whole envelope with an expiry, or nothing: a partial one cannot be
  -- decrypted, and one without an expiry would sign deliveries forever.
  ADD CONSTRAINT "callback_endpoints_previous_signing_secret_check"
  CHECK (
    ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_nonce" IS NULL)
    AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_auth_tag" IS NULL)
    AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_key_version" IS NULL)
    AND ("previous_signing_secret_ciphertext" IS NULL) = ("previous_signing_secret_expires_at" IS NULL)
  ),
  ADD CONSTRAINT "callback_endpoints_path_prefix_check" CHECK (left("path_prefix", 1) = '/');

ALTER TABLE "outbound_deliveries"
  ADD CONSTRAINT "outbound_deliveries_event_check"
  CHECK ("event" IN ('run.completed', 'run.waiting_for_human')),
  ADD CONSTRAINT "outbound_deliveries_attempts_check" CHECK ("attempts" >= 0);

-- Who launched the run, as every payload reports it: a known kind and a non-empty id.
ALTER TABLE "run_callbacks"
  ADD CONSTRAINT "run_callbacks_launched_by_check"
  CHECK (
    jsonb_typeof("launched_by") = 'object'
    AND "launched_by"->>'kind' IN ('user', 'service_principal', 'template_webhook', 'automation')
    AND coalesce("launched_by"->>'id', '') <> ''
  );
