import { describe, expect, it } from 'vitest';
import { hasRole, isRole, requiresRoleTitle } from './roles';

describe('hasRole', () => {
  it('orders roles ENGINEER < LEAD < ADMIN', () => {
    expect(hasRole('ENGINEER', 'ENGINEER')).toBe(true);
    expect(hasRole('ENGINEER', 'LEAD')).toBe(false);
    expect(hasRole('LEAD', 'LEAD')).toBe(true);
    expect(hasRole('LEAD', 'ENGINEER')).toBe(true);
    expect(hasRole('LEAD', 'ADMIN')).toBe(false);
    expect(hasRole('ADMIN', 'LEAD')).toBe(true);
    expect(hasRole('ADMIN', 'ADMIN')).toBe(true);
  });

  it('treats a missing or unknown role as meeting nothing', () => {
    expect(hasRole(undefined, 'ENGINEER')).toBe(false);
    expect(hasRole(null, 'ENGINEER')).toBe(false);
    expect(hasRole('SUPERUSER', 'ENGINEER')).toBe(false);
    expect(hasRole('admin', 'ENGINEER')).toBe(false);
  });
});

describe('isRole', () => {
  it('accepts only the three platform roles', () => {
    expect(isRole('LEAD')).toBe(true);
    expect(isRole('OWNER')).toBe(false);
    expect(isRole(3)).toBe(false);
  });
});

describe('requiresRoleTitle', () => {
  it('names the role', () => {
    expect(requiresRoleTitle('LEAD')).toBe('Requires the LEAD role');
  });
});
