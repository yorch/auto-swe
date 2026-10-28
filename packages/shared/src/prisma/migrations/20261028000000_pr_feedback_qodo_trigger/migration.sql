-- The `qodo_findings` trigger of the pull-request feedback source. The trigger list was
-- checked against the two original triggers only, so a feedback automation that listed the
-- Qodo trigger passed validation and was then refused by the database. The CHECK cannot be
-- altered in place, so it is replaced with the trigger added; same invariants as before.

ALTER TABLE "automations" DROP CONSTRAINT "automations_pr_feedback_filters";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_pr_feedback_filters"
    CHECK ("source" <> 'github.pull_request.feedback' OR COALESCE(
      "filters" ?& ARRAY['triggers', 'pullRequests']
      AND jsonb_typeof("filters"->'triggers') = 'array'
      AND jsonb_array_length("filters"->'triggers') > 0
      AND ("filters"->'triggers') <@ '["changes_requested", "command", "qodo_findings"]'::jsonb
      AND jsonb_typeof("filters"->'pullRequests') = 'array'
      AND jsonb_array_length("filters"->'pullRequests') > 0
      AND ("filters"->'pullRequests') <@ '["platform", "others"]'::jsonb,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
