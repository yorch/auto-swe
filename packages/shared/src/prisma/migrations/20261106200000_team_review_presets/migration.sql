ALTER TABLE "review_presets" ADD COLUMN "team_id" UUID REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "review_presets_name_key";
CREATE UNIQUE INDEX "review_presets_team_id_name_key" ON "review_presets"("team_id", "name");
CREATE UNIQUE INDEX "review_presets_global_name_key" ON "review_presets"("name") WHERE "team_id" IS NULL;

CREATE FUNCTION enforce_review_attachment_team() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preset_team UUID; target_team UUID;
BEGIN
  SELECT team_id INTO preset_team FROM review_presets WHERE id = NEW.preset_id FOR SHARE;
  IF preset_team IS NOT NULL THEN
    IF NEW.template_id IS NOT NULL THEN
      SELECT team_id INTO target_team FROM workflow_templates WHERE id = NEW.template_id FOR SHARE;
    ELSE
      SELECT team_id INTO target_team FROM connections WHERE id = NEW.connection_id FOR SHARE;
    END IF;
    IF target_team IS DISTINCT FROM preset_team THEN
      RAISE EXCEPTION 'Review attachment must belong to the preset team' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_attachment_team BEFORE INSERT OR UPDATE ON review_preset_attachments
FOR EACH ROW EXECUTE FUNCTION enforce_review_attachment_team();

CREATE FUNCTION protect_review_attachment_team() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.team_id IS DISTINCT FROM NEW.team_id AND EXISTS (
    SELECT 1 FROM review_preset_attachments a JOIN review_presets p ON p.id = a.preset_id
    WHERE p.team_id IS NOT NULL AND p.team_id IS DISTINCT FROM NEW.team_id AND
      ((TG_TABLE_NAME = 'workflow_templates' AND a.template_id = NEW.id) OR
       (TG_TABLE_NAME = 'connections' AND a.connection_id = NEW.id))
  ) THEN
    RAISE EXCEPTION 'Resource has team-scoped review attachments' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_template_attachment_team BEFORE UPDATE OF team_id ON workflow_templates
FOR EACH ROW EXECUTE FUNCTION protect_review_attachment_team();
CREATE TRIGGER review_repo_attachment_team BEFORE UPDATE OF team_id ON connections
FOR EACH ROW EXECUTE FUNCTION protect_review_attachment_team();
