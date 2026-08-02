-- Skills gain the ownership columns every other library entity already has.
--
-- Previously `skills` carried no tenant column at all: isolation was expressed
-- only by which Agents referenced a skill, so a custom (isVerified=false) skill
-- authored by one team was a global row any other tenant's agent could attach,
-- and its prompt_text was readable platform-wide.
ALTER TABLE "skills"
  ADD COLUMN "scope"   "ConfigScope" NOT NULL DEFAULT 'GLOBAL',
  ADD COLUMN "team_id" UUID,
  ADD COLUMN "org_id"  UUID;

ALTER TABLE "skills"
  ADD CONSTRAINT "skills_team_id_fkey" FOREIGN KEY ("team_id")
    REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "skills_org_id_fkey"  FOREIGN KEY ("org_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mirrors provider_credentials_scope_keys_check: the discriminator column must
-- match the scope, so a GLOBAL row cannot carry a team_id and leak into a
-- tenant's view, and a TEAM row cannot exist without one.
ALTER TABLE "skills"
  ADD CONSTRAINT "skills_scope_keys_check"
  CHECK (
      ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
      OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
      OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
  );

-- Built-in skills are platform content and stay GLOBAL; existing custom rows
-- predate tenancy and have no owner to attribute to, so they also remain
-- GLOBAL rather than being silently assigned to an arbitrary team.
CREATE INDEX "skills_scope_team_id_idx" ON "skills" ("scope", "team_id");
CREATE INDEX "skills_scope_org_id_idx"  ON "skills" ("scope", "org_id");
CREATE INDEX "skills_team_id_idx"       ON "skills" ("team_id");
CREATE INDEX "skills_org_id_idx"        ON "skills" ("org_id");
