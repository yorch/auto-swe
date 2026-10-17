-- The launch label a request is listed under, as its own column.
--
-- Lists show a template launch's `label` as the request's title, but it lived only inside
-- `request_payload`, so a text search could not reach it. The gateway's run and request filters
-- match this column instead of the raw payload.
--
-- A plain column, matching the schema's `title String?`; the trigger below, which Prisma does not
-- model, is what fills it.
ALTER TABLE "run_inputs" ADD COLUMN "title" TEXT;

-- The label, trimmed and cut to 200 characters, as the gateway shows it; null when the payload is
-- not a JSON object or carries no string label. It never raises: a payload the `json` parser
-- accepts can still hold an escape that has no text form (`\u0000`, an unpaired surrogate), and a
-- search column must not be able to fail a launch, so any error, wherever the escape sits in the
-- payload, yields no title. `json` rather than `jsonb` because the cast to `jsonb` raises on those
-- escapes, and `json` keeps the last of duplicate keys, as `JSON.parse` does.
CREATE OR REPLACE FUNCTION run_input_title(payload TEXT) RETURNS TEXT AS $$
DECLARE
  label TEXT;
BEGIN
  IF payload IS NOT JSON OBJECT THEN
    RETURN NULL;
  END IF;
  IF json_typeof(payload::json -> 'label') IS DISTINCT FROM 'string' THEN
    RETURN NULL;
  END IF;
  label := payload::json ->> 'label';
  RETURN NULLIF(left(regexp_replace(label, '^\s+|\s+$', '', 'g'), 200), '');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Data, not DDL: every request that already exists gets its title now.
UPDATE "run_inputs" SET "title" = run_input_title("request_payload")
WHERE run_input_title("request_payload") IS NOT NULL;

-- A trigger rather than a write at each launch path (template runs, webhooks, automations,
-- schedules, Slack, channel tasks, PRD and epic runs, re-runs) because the invariant belongs to
-- the column: a new path cannot forget it. It recomputes on every write, so the column always
-- follows the payload and a direct write to it does not stick.
CREATE OR REPLACE FUNCTION set_run_input_title() RETURNS trigger AS $$
BEGIN
  NEW."title" := run_input_title(NEW."request_payload");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "run_inputs_title"
BEFORE INSERT OR UPDATE ON "run_inputs"
FOR EACH ROW EXECUTE FUNCTION set_run_input_title();
