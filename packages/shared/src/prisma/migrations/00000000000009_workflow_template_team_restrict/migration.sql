-- A workflow template with a null team_id is GLOBAL — visible to every tenant.
-- ON DELETE SET NULL therefore turned deleting a team into publishing all of
-- its private templates platform-wide. RESTRICT makes the deletion fail until
-- the team's templates are removed or reassigned deliberately.
ALTER TABLE "workflow_templates" DROP CONSTRAINT "workflow_templates_team_id_fkey";

ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
