-- Rename the registry setting `github.trackerAllowedProjectKeys` to `tracker.allowedProjectKeys`.
-- A setting's identity is its key, so stored values and exact-key grants must move with it.
-- Idempotent: after one run no row carries the old key. Where a row for the new key already
-- exists at the same scope and target, it wins and the old row is deleted instead of renamed
-- (the per-scope partial unique indexes forbid both). `config_audit_log` is history and is
-- left untouched. Prefix grants (`github.*`, `*`) are unchanged: they cannot lower the
-- setting's ADMIN floor, and ADMINs bypass grants.

-- config_settings: drop old rows shadowed by an existing new-key row at the same scope/target.
DELETE FROM "config_settings" AS stale
WHERE stale."key" = 'github.trackerAllowedProjectKeys'
  AND EXISTS (
    SELECT 1
    FROM "config_settings" AS kept
    WHERE kept."key" = 'tracker.allowedProjectKeys'
      AND kept."scope" = stale."scope"
      AND kept."team_id" IS NOT DISTINCT FROM stale."team_id"
      AND kept."org_id" IS NOT DISTINCT FROM stale."org_id"
      AND kept."channel_id" IS NOT DISTINCT FROM stale."channel_id"
      AND kept."workflow_template_id" IS NOT DISTINCT FROM stale."workflow_template_id"
  );

UPDATE "config_settings"
SET "key" = 'tracker.allowedProjectKeys'
WHERE "key" = 'github.trackerAllowedProjectKeys';

-- config_permissions: a grant names a setting through `key_pattern` (exact key, `group.*` or `*`).
DELETE FROM "config_permissions" AS stale
WHERE stale."key_pattern" = 'github.trackerAllowedProjectKeys'
  AND EXISTS (
    SELECT 1
    FROM "config_permissions" AS kept
    WHERE kept."key_pattern" = 'tracker.allowedProjectKeys'
      AND kept."scope" = stale."scope"
      AND kept."user_id" IS NOT DISTINCT FROM stale."user_id"
      AND kept."role" IS NOT DISTINCT FROM stale."role"
      AND kept."team_id" IS NOT DISTINCT FROM stale."team_id"
      AND kept."org_id" IS NOT DISTINCT FROM stale."org_id"
  );

UPDATE "config_permissions"
SET "key_pattern" = 'tracker.allowedProjectKeys'
WHERE "key_pattern" = 'github.trackerAllowedProjectKeys';
