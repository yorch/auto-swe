import { describe, expect, it } from 'vitest';
import { assertCredentialScope, isCredentialScope } from './credentialScope.js';

describe('credentialScope guards', () => {
  it('accepts GLOBAL and TEAM', () => {
    expect(isCredentialScope('GLOBAL')).toBe(true);
    expect(isCredentialScope('TEAM')).toBe(true);
    expect(assertCredentialScope('GLOBAL')).toBe('GLOBAL');
    expect(assertCredentialScope('TEAM')).toBe('TEAM');
  });

  it('rejects WORKFLOW_TEMPLATE (the DB CHECK constraint forbids it)', () => {
    expect(isCredentialScope('WORKFLOW_TEMPLATE')).toBe(false);
    expect(() => assertCredentialScope('WORKFLOW_TEMPLATE')).toThrow(/GLOBAL.*TEAM/);
  });

  it('rejects anything non-string or arbitrary string', () => {
    expect(isCredentialScope(null)).toBe(false);
    expect(isCredentialScope(undefined)).toBe(false);
    expect(isCredentialScope('global')).toBe(false); // lowercase rejected
    expect(isCredentialScope(42)).toBe(false);
    expect(isCredentialScope({})).toBe(false);
  });
});
