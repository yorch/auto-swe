import { describe, expect, it } from 'vitest';
import { assertCredentialScope, isCredentialScope } from './credentialScope.js';

describe('credentialScope guards', () => {
  it('accepts GLOBAL, ORGANIZATION and TEAM — exactly what the DB CHECK allows', () => {
    expect(isCredentialScope('GLOBAL')).toBe(true);
    expect(isCredentialScope('ORGANIZATION')).toBe(true);
    expect(isCredentialScope('TEAM')).toBe(true);
    expect(assertCredentialScope('GLOBAL')).toBe('GLOBAL');
    expect(assertCredentialScope('ORGANIZATION')).toBe('ORGANIZATION');
    expect(assertCredentialScope('TEAM')).toBe('TEAM');
  });

  it('names the constraint that actually rejects the value', () => {
    expect(() => assertCredentialScope('CHANNEL')).toThrow(/provider_credentials_scope_check/);
  });

  it('rejects WORKFLOW_TEMPLATE (the DB CHECK constraint forbids it)', () => {
    expect(isCredentialScope('WORKFLOW_TEMPLATE')).toBe(false);
    expect(() => assertCredentialScope('WORKFLOW_TEMPLATE')).toThrow(/GLOBAL.*ORGANIZATION.*TEAM/);
  });

  it('rejects anything non-string or arbitrary string', () => {
    expect(isCredentialScope(null)).toBe(false);
    expect(isCredentialScope(undefined)).toBe(false);
    expect(isCredentialScope('global')).toBe(false); // lowercase rejected
    expect(isCredentialScope(42)).toBe(false);
    expect(isCredentialScope({})).toBe(false);
  });
});
