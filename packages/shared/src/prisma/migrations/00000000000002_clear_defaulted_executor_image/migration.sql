-- ----------------------------------------------------------------------------
-- Data fix-up: release connections that are holding the OLD COLUMN DEFAULT.
--
-- `connections.executor_image` used to default to 'node:24-alpine', and the
-- connection create path omits the field when the form is left blank — so
-- Postgres wrote that literal into the row and the connection looked pinned
-- when nobody had pinned it. The worker reads that column ahead of the
-- `workspace_image` Tier-2 default, so those rows shadow the image an operator
-- sets at /admin/workflow. The default was dropped so a blank field now means
-- NULL ("inherit"); this releases the rows created before that was true.
--
-- Why this is its own migration rather than an edit to 00000000000001: that one
-- is already applied wherever a database exists, so an edit there changes its
-- checksum and still never re-runs. A data fix-up can only reach existing rows
-- as a NEW migration. On a fresh database it is a harmless no-op — the table is
-- empty at this point in the replay — which is also why it is safe to re-run.
--
-- Limits of what this can know: `connections` carries no timestamps, so a row
-- an operator deliberately pinned to 'node:24-alpine' is indistinguishable from
-- one that merely got the default, and both are cleared. That is deliberate and
-- almost always invisible: a cleared row falls through to `workspace_image`,
-- whose own default is the same image. It changes the effective image only in a
-- deployment that ALSO moved that Tier-2 default — and there, inheriting it is
-- the behaviour the operator asked for.
-- ----------------------------------------------------------------------------

UPDATE "connections"
   SET "executor_image" = NULL
 WHERE "executor_image" = 'node:24-alpine';
