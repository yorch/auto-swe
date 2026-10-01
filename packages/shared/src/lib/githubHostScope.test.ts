import { describe, expect, it } from 'vitest';
import {
  hostFamily,
  installationTargetFor,
  instanceIsGithubDotCom,
  isDotcomStyleHost,
  platformCredentialScope,
  sameHostFamily,
} from './githubHostScope.js';

const DOTCOM = { apiUrl: 'https://api.github.com', baseUrl: 'https://github.com' };
const GHE = { apiUrl: 'https://ghe.corp/api/v3', baseUrl: 'https://ghe.corp' };
const APP = { appId: '1', appPrivateKey: 'k', authMode: 'app' };

describe('host families', () => {
  it('folds a hosted GitHub web host with its API host', () => {
    expect(hostFamily('https://api.github.com')).toBe('github.com');
    expect(hostFamily('https://github.com/')).toBe('github.com');
    expect(hostFamily('https://api.acme.ghe.com')).toBe('acme.ghe.com');
    expect(sameHostFamily('https://acme.ghe.com', 'https://api.acme.ghe.com')).toBe(true);
    expect(sameHostFamily('https://acme.ghe.com', 'https://api.other.ghe.com')).toBe(false);
    expect(sameHostFamily('https://ghe.corp', 'https://ghe.corp/api/v3')).toBe(true);
    expect(sameHostFamily('https://ghe.corp', 'https://api.github.com')).toBe(false);
  });

  it('classifies github.com and *.ghe.com (and their API hosts) as sending no enterprise header', () => {
    for (const h of ['github.com', 'api.github.com', 'acme.ghe.com', 'API.acme.ghe.com:443']) {
      expect(isDotcomStyleHost(h)).toBe(true);
    }
    for (const h of [
      'ghe.corp',
      'ghe.com',
      'github.com.evil.example',
      'a.b.ghe.com',
      'x.ghe.com.evil',
    ]) {
      expect(isDotcomStyleHost(h)).toBe(false);
    }
  });

  it('knows whether the instance is on github.com', () => {
    expect(instanceIsGithubDotCom(DOTCOM)).toBe(true);
    expect(instanceIsGithubDotCom(GHE)).toBe(false);
  });
});

describe('platformCredentialScope', () => {
  it('is "instance" with no overrides, or overrides spelling the instance host', () => {
    expect(platformCredentialScope({}, DOTCOM)).toBe('instance');
    expect(
      platformCredentialScope(
        { apiUrl: 'https://API.github.com/', baseUrl: 'https://github.com' },
        DOTCOM
      )
    ).toBe('instance');
  });

  it('is "misconfigured" for a half override, whichever side, with or without an installation', () => {
    for (const installationId of [null, '7']) {
      expect(
        platformCredentialScope(
          { baseUrl: 'https://ghe.corp', installationId },
          { ...DOTCOM, ...APP }
        )
      ).toBe('misconfigured');
      expect(
        platformCredentialScope(
          { apiUrl: 'https://ghe.corp/api/v3', installationId },
          { ...DOTCOM, ...APP }
        )
      ).toBe('misconfigured');
    }
    // A foreign pair with a different host on each side.
    expect(
      platformCredentialScope(
        { apiUrl: 'https://a.corp/api/v3', baseUrl: 'https://b.corp', installationId: '7' },
        { ...DOTCOM, ...APP }
      )
    ).toBe('misconfigured');
  });

  it('is "own-installation" only for a matching pair, with an installation, in App mode', () => {
    const pair = { apiUrl: GHE.apiUrl, baseUrl: GHE.baseUrl };
    expect(platformCredentialScope({ ...pair, installationId: '7' }, { ...DOTCOM, ...APP })).toBe(
      'own-installation'
    );
    expect(platformCredentialScope(pair, { ...DOTCOM, ...APP })).toBe('mismatch');
    expect(
      platformCredentialScope({ ...pair, installationId: '7' }, { ...DOTCOM, authMode: 'pat' })
    ).toBe('mismatch');
  });

  it('reaches a <tenant>.ghe.com pair through its own installation', () => {
    expect(
      platformCredentialScope(
        {
          apiUrl: 'https://api.acme.ghe.com',
          baseUrl: 'https://acme.ghe.com',
          installationId: '7',
        },
        { ...GHE, ...APP }
      )
    ).toBe('own-installation');
  });

  it('is "instance" on a GHE instance for a repository using no overrides', () => {
    expect(platformCredentialScope({}, GHE)).toBe('instance');
  });
});

describe('installationTargetFor', () => {
  it('takes the singleton installation, at the instance API, when the repository has none', () => {
    expect(installationTargetFor({ apiUrl: 'https://x/api' }, DOTCOM)).toEqual({
      apiUrl: DOTCOM.apiUrl,
      installationId: null,
    });
    expect(installationTargetFor({ apiUrl: GHE.apiUrl, installationId: '7' }, DOTCOM)).toEqual({
      apiUrl: GHE.apiUrl,
      installationId: '7',
    });
  });
});
