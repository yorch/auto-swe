import { describe, expect, it } from 'vitest';
import { budgetTierLabel, orgRoleLabel, platformRoleLabel } from './govLabels';

describe('govLabels', () => {
  it('names org roles, tiers and platform roles in plain language', () => {
    expect(orgRoleLabel('ORG_ADMIN')).toBe('Organization admin');
    expect(budgetTierLabel('EPIC')).toBe('Epic');
    expect(platformRoleLabel('LEAD')).toBe('Lead');
  });

  it('passes an unknown value through rather than hiding it', () => {
    expect(orgRoleLabel('SOMETHING')).toBe('SOMETHING');
  });
});
