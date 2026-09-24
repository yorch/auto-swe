import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trustProxy.js';

describe('parseTrustProxy', () => {
  it('defaults to not trusting forwarding headers', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy(' false ')).toBe(false);
  });

  it('parses true', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('parses a comma-separated list of proxy addresses', () => {
    expect(parseTrustProxy('10.0.0.1, 172.16.0.0/12,')).toEqual(['10.0.0.1', '172.16.0.0/12']);
  });

  it('refuses a bare hop count rather than silently trusting nothing', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
  });
});
