-- The base image a `jvm` eval case runs in now carries Maven (it was a bare JDK). A case's flake
-- screen ran its reference in the image the case ran in then, so a screen taken on the bare JDK says
-- nothing about the Maven one. Send every `jvm` case back to "not checked yet": the harness scores a
-- case only once a new screen passes, and the next screen of its dataset (an eval run, or an
-- admin's re-check) starts it. `quarantined` is left as it is.

-- UpdateData
UPDATE "eval_cases"
SET "flake_screened" = false, "flake_runs" = 0, "flake_screen_infra_errors" = 0
WHERE "stack" = 'jvm';
