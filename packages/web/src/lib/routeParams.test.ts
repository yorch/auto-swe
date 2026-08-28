import { describe, expect, it } from 'vitest';
import { validateRouteParam } from './routeParams';

describe('validateRouteParam', () => {
  it('returns the decoded string for a normal id', () => {
    expect(validateRouteParam('abc-123')).toBe('abc-123');
  });

  it('decodes URL-encoded characters', () => {
    expect(validateRouteParam('hello%20world')).toBe('hello world');
  });

  it('returns null for non-string values', () => {
    expect(validateRouteParam(undefined)).toBeNull();
    expect(validateRouteParam(null)).toBeNull();
    expect(validateRouteParam(123)).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(validateRouteParam('')).toBeNull();
    expect(validateRouteParam('   ')).toBeNull();
  });
});
