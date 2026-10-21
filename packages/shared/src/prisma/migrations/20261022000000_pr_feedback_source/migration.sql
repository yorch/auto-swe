-- The pull-request feedback event source (`github.pull_request.feedback`): known to the
-- automations table, with its two choice-list filters keeping the same invariants as the
-- other sources — non-empty arrays of known values (an empty list reads as "match nothing"
-- in code but "match everything" to a person). `automations_source_known` cannot be altered
-- in place, so it is replaced with the source added.

ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
    CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event', 'github.pull_request.feedback'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A CHECK that evaluates to NULL passes; COALESCE makes a missing list fail instead of
-- passing it, as in the sibling per-source checks.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_pr_feedback_filters"
    CHECK ("source" <> 'github.pull_request.feedback' OR COALESCE(
      "filters" ?& ARRAY['triggers', 'pullRequests']
      AND jsonb_typeof("filters"->'triggers') = 'array'
      AND jsonb_array_length("filters"->'triggers') > 0
      AND ("filters"->'triggers') <@ '["changes_requested", "command"]'::jsonb
      AND jsonb_typeof("filters"->'pullRequests') = 'array'
      AND jsonb_array_length("filters"->'pullRequests') > 0
      AND ("filters"->'pullRequests') <@ '["platform", "others"]'::jsonb,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
