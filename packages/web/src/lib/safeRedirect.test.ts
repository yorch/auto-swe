import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './safeRedirect';

const ORIGIN = 'https://app.example.com';

describe('safeRedirectPath', () => {
  it.each(['/runs', '/runs/abc?tab=trace', '/govern/budgets#top'])(
    'keeps the same-origin path %s',
    (p) => {
      expect(safeRedirectPath(p, ORIGIN)).toBe(p);
    }
  );

  it.each([
    ['/\\evil.com'],
    ['/%5Cevil.com'],
    ['/%5cevil.com'],
    ['//evil.com'],
    ['/%09/evil.com'],
    ['/\t/evil.com'],
    ['/\n/evil.com'],
    ['https://evil.com'],
    ['javascript:alert(1)'],
    ['evil.com'],
    [''],
  ])('rejects %j', (p) => {
    expect(safeRedirectPath(p, ORIGIN)).toBe('/');
  });

  // Dot segments collapse during URL resolution; the resolved path must be
  // re-checked or these come back as protocol-relative `//evil.com…`.
  it.each([
    ['/.//evil.com'],
    ['/..//evil.com'],
    ['/a/..//evil.com'],
    ['/%2e//evil.com'],
    ['/%2E%2E//evil.com/x?y'],
    ['/x/%2e%2e//evil.com'],
  ])('rejects %j, which resolves to a protocol-relative path', (p) => {
    expect(safeRedirectPath(p, ORIGIN)).toBe('/');
  });

  it('still normalises harmless dot segments', () => {
    expect(safeRedirectPath('/runs/../govern?x=1', ORIGIN)).toBe('/govern?x=1');
  });

  it('falls back when the parameter is absent', () => {
    expect(safeRedirectPath(null, ORIGIN)).toBe('/');
    expect(safeRedirectPath(undefined, ORIGIN, '/home')).toBe('/home');
  });
});
