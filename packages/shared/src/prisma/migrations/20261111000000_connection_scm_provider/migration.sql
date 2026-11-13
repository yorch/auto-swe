-- Which source-control host family serves a repository. NOT NULL with a constant default is a
-- metadata-only change on PostgreSQL 11+ (the default is stored in the catalog, not written to
-- each row), so adding it to "connections" takes no table rewrite. Every existing row is GitHub.
-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "scm_provider" TEXT NOT NULL DEFAULT 'github';
