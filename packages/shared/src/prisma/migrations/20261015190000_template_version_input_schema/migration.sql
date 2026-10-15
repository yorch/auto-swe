-- The schema a template version was created under.
--
-- A run pins the connections its payload declares, and the schema is what says which fields those
-- are. Reading it from the template meant an edit changed what a run already in flight could use,
-- and refused an experiment arm or a rollback a connection its own version declares.
--
-- The statement below is what `prisma migrate diff --from-config-datasource --to-schema` proposed
-- against a database carrying every migration before this one: it named this ALTER and nothing
-- else (besides the two indexes Prisma cannot express, which are pre-existing and are not part of
-- this migration).
ALTER TABLE "workflow_template_versions" ADD COLUMN     "input_schema" JSONB;

-- Data, not DDL: every version that already exists takes the schema its template carries at the
-- moment of this migration — the answer the code read before the column existed. A version created
-- afterwards writes its own, via the trigger below.
UPDATE "workflow_template_versions" AS v
SET "input_schema" = t."input_schema"
FROM "workflow_templates" AS t
WHERE v."template_id" = t."id" AND t."input_schema" IS NOT NULL;

-- A trigger rather than a write at each of the callers that create a version — the seeded built-ins,
-- a bundle install, a template save, a draft from the author agent, a channel refinement — because
-- the invariant belongs to the column: a new caller cannot forget it, and a caller that has a schema
-- of its own still sets the column, since only an insert that left it null is filled.
CREATE OR REPLACE FUNCTION snapshot_template_version_schema() RETURNS trigger AS $$
BEGIN
  IF NEW."input_schema" IS NULL THEN
    SELECT t."input_schema" INTO NEW."input_schema"
    FROM "workflow_templates" AS t WHERE t."id" = NEW."template_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workflow_template_versions_snapshot_schema"
BEFORE INSERT ON "workflow_template_versions"
FOR EACH ROW EXECUTE FUNCTION snapshot_template_version_schema();
