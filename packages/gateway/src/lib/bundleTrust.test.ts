import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBundleTrustedKeys } from './bundleTrust.js';

describe('resolveBundleTrustedKeys', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('trusts nothing, silently, when the variable is unset', () => {
    vi.stubEnv('BUNDLE_TRUSTED_KEYS', '');
    expect(resolveBundleTrustedKeys()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the well-formed keys', () => {
    const key = { id: 'k1', publicKeyPem: 'PEM' };
    vi.stubEnv('BUNDLE_TRUSTED_KEYS', JSON.stringify([key]));
    expect(resolveBundleTrustedKeys()).toEqual([key]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('trusts nothing but warns when the JSON is malformed', () => {
    vi.stubEnv('BUNDLE_TRUSTED_KEYS', '[{"id":');
    expect(resolveBundleTrustedKeys()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('trusts nothing but warns when the JSON is not an array', () => {
    vi.stubEnv('BUNDLE_TRUSTED_KEYS', '{"id":"k1","publicKeyPem":"PEM"}');
    expect(resolveBundleTrustedKeys()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a JSON array'));
  });

  it('warns about entries it drops, without echoing them', () => {
    const key = { id: 'k1', publicKeyPem: 'PEM' };
    vi.stubEnv('BUNDLE_TRUSTED_KEYS', JSON.stringify([key, { id: 2 }]));
    expect(resolveBundleTrustedKeys()).toEqual([key]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored 1 malformed'));
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('PEM');
  });
});
