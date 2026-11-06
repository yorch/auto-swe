-- CreateEnum
CREATE TYPE "KnowledgeBaseVisibility" AS ENUM ('TEAM', 'SHARED', 'ORG');

-- CreateEnum
CREATE TYPE "KnowledgeBaseStatus" AS ENUM ('OK', 'DISABLED');

-- CreateEnum
CREATE TYPE "KnowledgeBaseLinkScope" AS ENUM ('TEAM', 'REPO', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "KnowledgeBaseSnapshotStatus" AS ENUM ('INDEXING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "knowledge_base_overrides" JSONB,
ADD COLUMN     "knowledge_bases" JSONB,
ADD COLUMN     "knowledge_bases_for" TEXT;

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mount_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "default_ref" TEXT,
    "visibility" "KnowledgeBaseVisibility" NOT NULL DEFAULT 'TEAM',
    "status" "KnowledgeBaseStatus" NOT NULL DEFAULT 'OK',
    "last_indexed_sha" TEXT,
    "last_indexed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_team_shares" (
    "knowledge_base_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    CONSTRAINT "knowledge_base_team_shares_pkey" PRIMARY KEY ("knowledge_base_id","team_id")
);

-- CreateTable
CREATE TABLE "knowledge_base_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "knowledge_base_id" UUID NOT NULL,
    "scope" "KnowledgeBaseLinkScope" NOT NULL,
    "team_id" UUID,
    "repo_id" UUID,
    "template_id" UUID,
    "ref" TEXT,
    "mount_name" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "exclude" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "knowledge_base_id" UUID NOT NULL,
    "sha" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" "KnowledgeBaseSnapshotStatus" NOT NULL DEFAULT 'INDEXING',
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "flagged_files" JSONB NOT NULL DEFAULT '[]',
    "skipped_files" JSONB NOT NULL DEFAULT '[]',
    "embedding_model" TEXT,
    "error" TEXT,
    "indexed_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_base_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "content_digest" TEXT NOT NULL,
    "embedding" vector(1536),
    "embedding_model" TEXT,

    CONSTRAINT "knowledge_base_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_connection_id_key" ON "knowledge_bases"("connection_id");

-- CreateIndex
CREATE INDEX "knowledge_bases_org_id_idx" ON "knowledge_bases"("org_id");

-- CreateIndex
CREATE INDEX "knowledge_base_links_team_id_idx" ON "knowledge_base_links"("team_id");
CREATE UNIQUE INDEX "knowledge_base_links_team_key" ON "knowledge_base_links"("knowledge_base_id", "team_id") WHERE "scope" = 'TEAM';

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_links_repo_key" ON "knowledge_base_links"("knowledge_base_id", "repo_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_links_template_key" ON "knowledge_base_links"("knowledge_base_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_snapshots_knowledge_base_id_sha_path_key" ON "knowledge_base_snapshots"("knowledge_base_id", "sha", "path");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_chunks_snapshot_id_path_chunk_index_key" ON "knowledge_base_chunks"("snapshot_id", "path", "chunk_index");

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_team_shares" ADD CONSTRAINT "knowledge_base_team_shares_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_team_shares" ADD CONSTRAINT "knowledge_base_team_shares_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_links" ADD CONSTRAINT "knowledge_base_links_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_links" ADD CONSTRAINT "knowledge_base_links_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_links" ADD CONSTRAINT "knowledge_base_links_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_links" ADD CONSTRAINT "knowledge_base_links_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_links" ADD CONSTRAINT "knowledge_base_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_snapshots" ADD CONSTRAINT "knowledge_base_snapshots_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_chunks" ADD CONSTRAINT "knowledge_base_chunks_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "knowledge_base_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_base_links"
  ADD CONSTRAINT "knowledge_base_links_mandatory_check" CHECK (NOT mandatory OR scope = 'TEAM'),
  ADD CONSTRAINT "knowledge_base_links_exclude_check" CHECK (NOT exclude OR scope = 'TEMPLATE'),
  ADD CONSTRAINT "knowledge_base_links_target_check" CHECK (
    (scope = 'TEAM' AND team_id IS NOT NULL AND repo_id IS NULL AND template_id IS NULL) OR
    (scope = 'REPO' AND team_id IS NOT NULL AND repo_id IS NOT NULL AND template_id IS NULL) OR
    (scope = 'TEMPLATE' AND repo_id IS NULL AND template_id IS NOT NULL)
  );

CREATE INDEX "knowledge_base_chunks_embedding_hnsw_idx" ON "knowledge_base_chunks"
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
