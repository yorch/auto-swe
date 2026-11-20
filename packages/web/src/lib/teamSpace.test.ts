import { describe, expect, it } from 'vitest';
import { TEAM_TABS, teamHref, teamSlugFromPath, teamTabFromPath } from './teamSpace';

describe('team space addresses', () => {
  it('builds a tab address from the slug', () => {
    expect(teamHref('payments')).toBe('/teams/payments');
    expect(teamHref('payments', 'manage')).toBe('/teams/payments/manage');
    expect(teamHref('a b', 'settings')).toBe('/teams/a%20b/settings');
  });

  it('reads the tab back from a pathname', () => {
    expect(teamTabFromPath('/teams/payments')).toBe('overview');
    for (const tab of TEAM_TABS) {
      expect(teamTabFromPath(teamHref('payments', tab.id))).toBe(tab.id);
    }
    expect(teamTabFromPath('/teams/payments/unknown')).toBeNull();
    expect(teamTabFromPath('/runs')).toBeNull();
  });

  it('reads the slug from a pathname', () => {
    expect(teamSlugFromPath('/teams/payments/members')).toBe('payments');
    expect(teamSlugFromPath('/teams')).toBeNull();
  });
});
