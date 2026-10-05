import { describe, expect, it } from 'vitest';
import { resolveLoginTab } from './loginTab';

describe('resolveLoginTab', () => {
  it('defaults to magic link when it is on', () => {
    expect(resolveLoginTab(null, true, false)).toBe('magic');
  });
  it('is password when magic link is off, whatever was picked', () => {
    expect(resolveLoginTab(null, false, false)).toBe('password');
    expect(resolveLoginTab('magic', false, false)).toBe('password');
  });
  it('defaults to password while an app sign-in is pending, but honours a pick', () => {
    expect(resolveLoginTab(null, true, true)).toBe('password');
    expect(resolveLoginTab('magic', true, true)).toBe('magic');
  });
});
