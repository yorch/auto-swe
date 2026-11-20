import { describe, expect, it } from 'vitest';
import { budgetTierLabel, roleChangeNeedsConfirm } from './govLabels';

describe('govLabels', () => {
  it('names budget tiers in plain language', () => {
    expect(budgetTierLabel('EPIC')).toBe('Epic');
    expect(budgetTierLabel('SOMETHING')).toBe('SOMETHING');
  });
});

describe('roleChangeNeedsConfirm', () => {
  it('asks before a platform role changes, and not when it stays', () => {
    expect(roleChangeNeedsConfirm('USER', 'ADMIN')).toBe(true);
    expect(roleChangeNeedsConfirm('ADMIN', 'USER')).toBe(true);
    expect(roleChangeNeedsConfirm('USER', 'USER')).toBe(false);
  });
});
