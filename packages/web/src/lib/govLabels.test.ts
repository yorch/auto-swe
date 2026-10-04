import { describe, expect, it } from 'vitest';
import {
  budgetTierLabel,
  orgRoleLabel,
  platformRoleLabel,
  roleChangeNeedsConfirm,
} from './govLabels';

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

describe('roleChangeNeedsConfirm', () => {
  it('confirms admin grants and demotions only', () => {
    expect(roleChangeNeedsConfirm('ENGINEER', 'ADMIN')).toBe(true);
    expect(roleChangeNeedsConfirm('ADMIN', 'LEAD')).toBe(true);
    expect(roleChangeNeedsConfirm('LEAD', 'ENGINEER')).toBe(true);
    expect(roleChangeNeedsConfirm('ENGINEER', 'LEAD')).toBe(false);
  });
});
