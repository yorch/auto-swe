CREATE TYPE "KnowledgeType" AS ENUM ('LEARNING', 'REFERENCE', 'DECISION', 'POLICY');
CREATE TYPE "KnowledgeStatus" AS ENUM ('UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "KnowledgeVisibility" AS ENUM ('REPOSITORY', 'TEAM', 'SELECTED_TEAMS', 'ORGANIZATION');

CREATE TABLE "knowledge_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_team_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "origin_team_id" UUID NOT NULL,
  "repo_id" UUID,
  "type" "KnowledgeType" NOT NULL DEFAULT 'LEARNING',
  "status" "KnowledgeStatus" NOT NULL DEFAULT 'UNREVIEWED',
  "visibility" "KnowledgeVisibility" NOT NULL DEFAULT 'REPOSITORY',
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "entity_type" TEXT,
  "entity_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "approved_version" INTEGER,
  "producer_run_id" UUID,
  "producer_node_id" TEXT,
  "producer_agent_key" TEXT,
  "model_spec" TEXT,
  "idempotency_key" TEXT,
  "content_digest" TEXT NOT NULL,
  "evidence" JSONB,
  "embedding" vector(1536),
  "embedding_model" TEXT,
  "embedding_digest" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by_id" UUID,
  "approved_at" TIMESTAMPTZ,
  CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_items_version_positive" CHECK ("version" > 0),
  CONSTRAINT "knowledge_items_approval_version_check" CHECK (
    ("status" = 'APPROVED' AND "approved_version" IS NOT NULL AND "approved_version" = "version" AND "approved_at" IS NOT NULL)
    OR ("status" <> 'APPROVED' AND "approved_version" IS NULL AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
  ),
  CONSTRAINT "knowledge_items_owner_team_fkey" FOREIGN KEY ("owner_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_items_org_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_items_origin_team_fkey" FOREIGN KEY ("origin_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_items_repo_fkey" FOREIGN KEY ("repo_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_items_approved_by_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "knowledge_items_producer_run_id_producer_node_id_idempotency_key_key" ON "knowledge_items"("producer_run_id", "producer_node_id", "idempotency_key");
CREATE INDEX "knowledge_items_owner_team_id_status_visibility_idx" ON "knowledge_items"("owner_team_id", "status", "visibility");
CREATE INDEX "knowledge_items_org_id_status_visibility_idx" ON "knowledge_items"("org_id", "status", "visibility");
CREATE INDEX "knowledge_items_repo_id_status_idx" ON "knowledge_items"("repo_id", "status");
CREATE INDEX "knowledge_items_embedding_hnsw_idx" ON "knowledge_items" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 200);

CREATE TABLE "knowledge_item_team_grants" (
  "knowledge_item_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  CONSTRAINT "knowledge_item_team_grants_pkey" PRIMARY KEY ("knowledge_item_id", "team_id"),
  CONSTRAINT "knowledge_item_team_grants_item_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_item_team_grants_team_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "knowledge_item_team_grants_team_id_idx" ON "knowledge_item_team_grants"("team_id");

CREATE TABLE "knowledge_item_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "knowledge_item_id" UUID NOT NULL,
  "actor_id" UUID,
  "action" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_item_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_item_events_item_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_item_events_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "knowledge_item_events_knowledge_item_id_created_at_idx" ON "knowledge_item_events"("knowledge_item_id", "created_at");

-- The denormalized tenant and source fields are part of the ACL. Enforce their
-- consistency in the database so a malformed writer cannot create cross-org grants.
CREATE FUNCTION enforce_knowledge_item_scope() RETURNS trigger AS $$
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
CREATE TRIGGER "knowledge_items_scope_guard"
  BEFORE INSERT OR UPDATE OF "owner_team_id", "origin_team_id", "org_id", "repo_id"
  ON "knowledge_items" FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_item_scope();

CREATE FUNCTION enforce_knowledge_grant_scope() RETURNS trigger AS $$
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
CREATE TRIGGER "knowledge_item_team_grants_scope_guard"
  BEFORE INSERT OR UPDATE OF "knowledge_item_id", "team_id"
  ON "knowledge_item_team_grants" FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_grant_scope();
