import { describe, expect, it } from 'vitest';
import {
  defaultApiUrlForHost,
  hostFamily,
  installationHostFor,
  installationTargetFor,
  isDotcomStyleHost,
  platformCredentialScope,
  repoHostFamily,
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

  it('derives the standard API base of a host family', () => {
    expect(defaultApiUrlForHost('github.com')).toBe('https://api.github.com');
    expect(defaultApiUrlForHost('acme.ghe.com')).toBe('https://api.acme.ghe.com');
    expect(defaultApiUrlForHost('ghe.corp')).toBe('https://ghe.corp/api/v3');
    expect(defaultApiUrlForHost('ghe.corp:8443')).toBe('https://ghe.corp:8443/api/v3');
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

  it('is "mismatch" for a matching foreign pair, installation or not, in any mode', () => {
    const pair = { apiUrl: GHE.apiUrl, baseUrl: GHE.baseUrl };
    for (const config of [
      { ...DOTCOM, ...APP },
      { ...DOTCOM, authMode: 'pat' },
    ]) {
      expect(platformCredentialScope({ ...pair, installationId: '7' }, config)).toBe('mismatch');
      expect(platformCredentialScope(pair, config)).toBe('mismatch');
    }
  });

  it('is "mismatch" for a foreign <tenant>.ghe.com pair, even with an installation', () => {
    expect(
      platformCredentialScope(
        {
          apiUrl: 'https://api.acme.ghe.com',
          baseUrl: 'https://acme.ghe.com',
          installationId: '7',
        },
        { ...GHE, ...APP }
      )
    ).toBe('mismatch');
  });

  it('is "instance" on a GHE instance for a repository using no overrides', () => {
    expect(platformCredentialScope({}, GHE)).toBe('instance');
  });

  describe('with credentials configured for other hosts', () => {
    const pair = { apiUrl: GHE.apiUrl, baseUrl: GHE.baseUrl };

    it('is "host" for a matching foreign pair whose host family has a credential set', () => {
      expect(platformCredentialScope(pair, DOTCOM, ['ghe.corp'])).toBe('host');
      expect(
        platformCredentialScope(
          { apiUrl: 'https://api.acme.ghe.com', baseUrl: 'https://acme.ghe.com' },
          GHE,
          ['acme.ghe.com']
        )
      ).toBe('host');
    });

    it('stays "mismatch" for a host that has none, and is never confused by another host\'s set', () => {
      expect(platformCredentialScope(pair, DOTCOM, ['ghe.other'])).toBe('mismatch');
      expect(platformCredentialScope(pair, DOTCOM, [])).toBe('mismatch');
    });

    it('never lets a configured host turn a half override into a usable one', () => {
      expect(platformCredentialScope({ baseUrl: 'https://ghe.corp' }, DOTCOM, ['ghe.corp'])).toBe(
        'misconfigured'
      );
      expect(
        platformCredentialScope(
          { apiUrl: 'https://a.corp/api/v3', baseUrl: 'https://b.corp' },
          DOTCOM,
          ['a.corp', 'b.corp']
        )
      ).toBe('misconfigured');
    });

    it('is still "instance" on the instance host, whatever else is configured', () => {
      expect(platformCredentialScope({}, DOTCOM, ['github.com', 'ghe.corp'])).toBe('instance');
    });

    it('treats a data-residency tenant that is not the instance as a host of its own', () => {
      // The instance is github.com; acme.ghe.com is another host with its own credentials.
      const tenant = { apiUrl: 'https://api.acme.ghe.com', baseUrl: 'https://acme.ghe.com' };
      expect(platformCredentialScope(tenant, DOTCOM)).toBe('mismatch');
      expect(platformCredentialScope(tenant, DOTCOM, ['acme.ghe.com'])).toBe('host');
    });
  });
});

describe('repoHostFamily and installationHostFor', () => {
  it("name the repository's host family, and the installation host it takes", () => {
    expect(repoHostFamily({}, DOTCOM)).toBe('github.com');
    expect(repoHostFamily({ baseUrl: 'https://ghe.corp' }, DOTCOM)).toBe('ghe.corp');
    // The instance's host is the empty installation host, however it is spelled.
    expect(installationHostFor({}, DOTCOM)).toBe('');
    expect(
      installationHostFor(
        { apiUrl: 'https://API.github.com', baseUrl: 'https://github.com' },
        DOTCOM
      )
    ).toBe('');
    expect(installationHostFor({ apiUrl: GHE.apiUrl, baseUrl: GHE.baseUrl }, DOTCOM)).toBe(
      'ghe.corp'
    );
  });
});

describe('installationTargetFor', () => {
  it('takes the singleton installation, at the instance API, when the repository has none', () => {
    expect(installationTargetFor({ apiUrl: 'https://x/api' }, DOTCOM)).toEqual({
      apiUrl: DOTCOM.apiUrl,
      installationId: null,
    });
  });

  it('asks only the API of the credential set it is given, even for a repository on another host', () => {
    expect(installationTargetFor({ apiUrl: GHE.apiUrl, installationId: '7' }, DOTCOM)).toEqual({
      apiUrl: DOTCOM.apiUrl,
      installationId: '7',
    });
    expect(installationTargetFor({ apiUrl: GHE.apiUrl, installationId: '7' }, GHE)).toEqual({
      apiUrl: GHE.apiUrl,
      installationId: '7',
    });
  });
});
