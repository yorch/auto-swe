import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFINITIONS } from './registry.js';

const OLD_KEY = 'github.trackerAllowedProjectKeys';
const NEW_KEY = 'tracker.allowedProjectKeys';

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20261117300000_rename_tracker_allowed_project_keys/migration.sql'
  ),
  'utf8'
);

describe('rename tracker allowed project keys migration', () => {
  it('renames the stored setting key', () => {
    expect(sql).toContain(
      `UPDATE "config_settings"\nSET "key" = '${NEW_KEY}'\nWHERE "key" = '${OLD_KEY}'`
    );
  });

  it('renames the exact-key grants', () => {
    expect(sql).toContain(
      `UPDATE "config_permissions"\nSET "key_pattern" = '${NEW_KEY}'\nWHERE "key_pattern" = '${OLD_KEY}'`
    );
  });

  it('deletes a shadowed old row before renaming, in both tables', () => {
    expect(sql.indexOf('DELETE FROM "config_settings"')).toBeLessThan(
      sql.indexOf('UPDATE "config_settings"')
    );
    expect(sql.indexOf('DELETE FROM "config_permissions"')).toBeLessThan(
      sql.indexOf('UPDATE "config_permissions"')
    );
  });

  it('leaves the audit log alone', () => {
    expect(sql).not.toMatch(/(UPDATE|DELETE FROM)\s+"config_audit_log"/);
  });

  it('targets a key that exists, and no key that does', () => {
    expect(SETTING_DEFINITIONS).toHaveProperty([NEW_KEY]);
    expect(SETTING_DEFINITIONS).not.toHaveProperty([OLD_KEY]);
    expect(SETTING_DEFINITIONS[NEW_KEY as keyof typeof SETTING_DEFINITIONS].group).toBe('tracker');
  });
});
