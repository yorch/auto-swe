import { describe, expect, it } from 'vitest';
import {
  checkGitHubHostOverride,
  configuredGitHubOrigins,
  isTrustedGitHubHost,
  trustedGitHubOrigins,
} from './githubHostTrust.js';

const PUBLIC = { apiUrl: 'https://api.github.com', baseUrl: 'https://github.com' };
const GHE = { apiUrl: 'https://ghe.corp.example/api/v3', baseUrl: 'https://ghe.corp.example' };

describe('trusted origins', () => {
  it('configured origins are only the configured instance', () => {
    expect(configuredGitHubOrigins(GHE)).toEqual(['https://ghe.corp.example']);
  });

  it('trusted origins add public GitHub to the configured instance', () => {
    expect(trustedGitHubOrigins(GHE)).toEqual([
      'https://ghe.corp.example',
      'https://github.com',
      'https://api.github.com',
    ]);
  });

  it('a malformed configured URL contributes nothing', () => {
    expect(configuredGitHubOrigins({ apiUrl: 'not a url', baseUrl: 'https://github.com' })).toEqual(
      ['https://github.com']
    );
  });
});

describe('checkGitHubHostOverride', () => {
  it('accepts and normalises a configured GHE web base and API base', () => {
    expect(checkGitHubHostOverride('web', 'https://GHE.corp.example/', GHE)).toEqual({
      ok: true,
      value: 'https://ghe.corp.example',
    });
    expect(checkGitHubHostOverride('api', 'https://ghe.corp.example/api/v3/', GHE)).toEqual({
      ok: true,
      value: 'https://ghe.corp.example/api/v3',
    });
  });

  it('accepts public GitHub whatever instance is configured', () => {
    expect(checkGitHubHostOverride('web', 'https://github.com', GHE).ok).toBe(true);
    expect(checkGitHubHostOverride('api', 'https://api.github.com', GHE).ok).toBe(true);
  });

  it('rejects a host nobody configured', () => {
    for (const raw of [
      'https://attacker.example',
      'https://github.com.attacker.example',
      'http://github.com',
      'https://ghe.corp.example:8443',
    ]) {
      expect(checkGitHubHostOverride('api', raw, GHE).ok, raw).toBe(false);
    }
  });

  it('rejects a per-repository URL and any path beyond /api/v3', () => {
    expect(checkGitHubHostOverride('web', 'https://github.com/acme/api', PUBLIC).ok).toBe(false);
    expect(checkGitHubHostOverride('web', 'https://ghe.corp.example/api/v3', GHE).ok).toBe(false);
    expect(
      checkGitHubHostOverride('api', 'https://ghe.corp.example/api/v3/repos/acme/api', GHE).ok
    ).toBe(false);
  });

  it('rejects credentials, queries and fragments', () => {
    expect(checkGitHubHostOverride('web', 'https://user:pw@github.com', PUBLIC).ok).toBe(false);
    expect(checkGitHubHostOverride('web', 'https://github.com?x=1', PUBLIC).ok).toBe(false);
    expect(checkGitHubHostOverride('web', 'https://github.com#x', PUBLIC).ok).toBe(false);
    expect(checkGitHubHostOverride('web', 'not a url', PUBLIC).ok).toBe(false);
  });
});

describe('isTrustedGitHubHost (point of use)', () => {
  it('trusts configured and public GitHub origins', () => {
    expect(isTrustedGitHubHost('https://ghe.corp.example/api/v3', GHE)).toBe(true);
    expect(isTrustedGitHubHost('https://api.github.com', GHE)).toBe(true);
  });

  it('refuses a foreign origin, userinfo, and garbage', () => {
    expect(isTrustedGitHubHost('https://attacker.example/api/v3', GHE)).toBe(false);
    expect(isTrustedGitHubHost('https://x@ghe.corp.example', GHE)).toBe(false);
    expect(isTrustedGitHubHost('', GHE)).toBe(false);
  });
});
