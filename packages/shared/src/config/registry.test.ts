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
