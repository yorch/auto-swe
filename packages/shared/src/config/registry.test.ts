import { describe, expect, it } from 'vitest';
import { SETTING_DEFINITIONS } from './registry.js';

describe('retention settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;

  it('audit.configLogRetentionDays is 0 (forever) or between a year and ten years', () => {
    const key = 'audit.configLogRetentionDays';
    for (const ok of [0, 365, 3650]) {
      expect(accepts(key, ok), String(ok)).toBe(true);
    }
    for (const bad of [30, 364, 3651, -1, 400.5, '365', null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    expect(SETTING_DEFINITIONS[key].defaultValue).toBe(0);
    expect(SETTING_DEFINITIONS[key].overridableAt).toEqual([]);
    expect(SETTING_DEFINITIONS[key].requiredRole).toBe('ADMIN');
  });

  it('analytics.activityRetentionDays is at least a week', () => {
    const key = 'analytics.activityRetentionDays';
    for (const ok of [7, 90, 3650]) {
      expect(accepts(key, ok), String(ok)).toBe(true);
    }
    for (const bad of [3, 6, 0, 3651]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    expect(SETTING_DEFINITIONS[key].defaultValue).toBe(90);
  });

  it('page-view events are off by default', () => {
    expect(SETTING_DEFINITIONS['analytics.uiEventsEnabled'].defaultValue).toBe(false);
  });
});

describe('git author settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;

  it('are defined in the git group with LEAD role and template/team/org overrides', () => {
    const defaults = {
      'git.authorEmail': 'auto-swe@localhost',
      'git.authorName': 'auto-swe',
      'git.launcherAttribution': 'none',
    } as const;
    for (const [key, value] of Object.entries(defaults)) {
      const def = SETTING_DEFINITIONS[key as keyof typeof defaults];
      expect(def.defaultValue, key).toBe(value);
      expect(def.group, key).toBe('git');
      expect(def.overridableAt, key).toEqual(['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION']);
      expect(def.requiredRole, key).toBe('LEAD');
      expect(def.runPinned, key).toBe(false);
    }
  });

  it('git.authorName rejects empty, overlong, control-character and angle-bracket values', () => {
    const key = 'git.authorName';
    for (const ok of ['auto-swe', 'Acme Bot', 'a'.repeat(100)]) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of ['', 'a'.repeat(101), 'a\nb', 'a\rb', 'a\u0000b', 'a<b', 'a>b', 5, null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    for (const bad of [' ', '   ', 'a b', 'a b', 'a‮b', 'a​b']) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });

  it('git.authorName rejects names git refuses to commit with (only ident crud characters)', () => {
    const key = 'git.authorName';
    for (const bad of [',;', '"', "''", '\\', '. ,', '.', ':;<', '\t ']) {
      expect(accepts(key, bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["O'Brien", 'a.', '.a', 'Acme Bot', 'auto-swe']) {
      expect(accepts(key, ok), ok).toBe(true);
    }
  });

  it('git.authorEmail accepts the TLD-less default and rejects malformed values', () => {
    const key = 'git.authorEmail';
    const longest = `${'a'.repeat(245)}@acme.com`;
    expect(longest.length).toBe(254);
    for (const ok of ['auto-swe@localhost', 'bot@acme.example', longest]) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'no-at-sign',
      'a@b@c',
      'a b@c.com',
      'a@c.com\n',
      'a\tb@c.com',
      'a<b@c.com',
      'a@c>.com',
      'a‮b@c.com',
      `a${longest}`,
      5,
    ]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });

  it('git.launcherAttribution accepts only the three modes', () => {
    const key = 'git.launcherAttribution';
    for (const ok of ['none', 'co-author-trailer', 'author']) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of ['', 'trailer', 'None', true, null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });
});
