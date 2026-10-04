import { describe, expect, it, vi } from 'vitest';
import {
  type HostCredential,
  hostCredentialConfig,
  hostKeyOf,
  platformCredentialFor,
} from './githubHostCredential.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

const INSTANCE: ResolvedGitHubConfig = {
  apiUrl: 'https://api.github.com',
  appClientId: 'cid',
  appClientSecret: 'csecret',
  appId: '1',
  appInstallationId: '900',
  appPrivateKey: 'instance-key',
  authMode: 'app',
  baseUrl: 'https://github.com',
  oauthClientId: 'oid',
  oauthClientSecret: 'osecret',
  token: 'instance-pat',
  webhookSecret: 'instance-whsec',
};

const cred = (over: Partial<HostCredential> = {}): HostCredential => ({
  appId: null,
  appPrivateKey: null,
  host: 'ghe.corp',
  token: 'host-pat',
  ...over,
});

const GHE_REPO = {
  apiUrl: 'https://ghe.corp/api/v3',
  baseUrl: 'https://ghe.corp',
  installationHost: null,
};

describe('hostKeyOf', () => {
  it('folds a hosted GitHub web and API name into one host key', () => {
    expect(hostKeyOf('api.github.com')).toBe('github.com');
    expect(hostKeyOf('API.acme.ghe.com')).toBe('acme.ghe.com');
    expect(hostKeyOf('ghe.corp:8443')).toBe('ghe.corp:8443');
  });
});

describe('hostCredentialConfig', () => {
  it("carries only the host's own credentials, nothing of the instance's", () => {
    const config = hostCredentialConfig(cred({ appId: '5', appPrivateKey: 'host-key' }), GHE_REPO);
    expect(config).toMatchObject({
      apiUrl: GHE_REPO.apiUrl,
      appId: '5',
      appInstallationId: null,
      appPrivateKey: 'host-key',
      authMode: null,
      baseUrl: GHE_REPO.baseUrl,
      token: 'host-pat',
    });
    expect(JSON.stringify(config)).not.toMatch(
      /instance-pat|instance-key|csecret|osecret|instance-whsec|900/
    );
  });

  it('does not borrow the instance PAT when the host has only an App', () => {
    const config = hostCredentialConfig(
      cred({ appId: '5', appPrivateKey: 'host-key', token: null }),
      GHE_REPO
    );
    expect(config.token).toBeNull();
  });
});

describe('platformCredentialFor and the installation host', () => {
  it('refuses an installation recorded for another host, on the instance and on a host', async () => {
    const lookup = vi.fn().mockResolvedValue(cred());
    expect(
      await platformCredentialFor(
        { installationHost: 'ghe.corp', installationId: '7' },
        INSTANCE,
        lookup
      )
    ).toEqual({ host: 'github.com', scope: 'installation-mismatch' });
    expect(
      await platformCredentialFor(
        { ...GHE_REPO, installationHost: '', installationId: '7' },
        INSTANCE,
        lookup
      )
    ).toEqual({ host: 'ghe.corp', scope: 'installation-mismatch' });
  });

  it('accepts a matching installation, and refuses one whose host is absent', async () => {
    const lookup = vi.fn().mockResolvedValue(cred());
    expect(
      (await platformCredentialFor({ installationHost: '', installationId: '7' }, INSTANCE, lookup))
        .scope
    ).toBe('instance');
    expect(
      (
        await platformCredentialFor(
          { ...GHE_REPO, installationHost: 'ghe.corp', installationId: '7' },
          INSTANCE,
          lookup
        )
      ).scope
    ).toBe('host');
    expect(
      (await platformCredentialFor({ ...GHE_REPO, installationId: '7' }, INSTANCE, lookup)).scope
    ).toBe('installation-mismatch');
  });

  it("sets the host set's credentialHost to its row's host", async () => {
    const r = await platformCredentialFor(GHE_REPO, INSTANCE, async () => cred());
    if (r.scope === 'host') {
      expect(r.config.credentialHost).toBe('ghe.corp');
    }
  });
});

describe('platformCredentialFor', () => {
  it("returns the instance's own set for an instance repository, without a lookup", async () => {
    const lookup = vi.fn();
    const r = await platformCredentialFor({ installationHost: null }, INSTANCE, lookup);
    expect(r).toEqual({ config: INSTANCE, scope: 'instance' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns the host's set for a repository on a configured host", async () => {
    const lookup = vi.fn().mockResolvedValue(cred());
    const r = await platformCredentialFor(GHE_REPO, INSTANCE, lookup);
    expect(lookup).toHaveBeenCalledWith('ghe.corp');
    expect(r).toMatchObject({ host: 'ghe.corp', scope: 'host' });
    if (r.scope === 'host') {
      expect(r.config.token).toBe('host-pat');
      expect(r.config.apiUrl).toBe(GHE_REPO.apiUrl);
    }
  });

  it('is a mismatch for a host with no usable credentials, and never falls back to the instance', async () => {
    const r = await platformCredentialFor(GHE_REPO, INSTANCE, async () => null);
    expect(r).toEqual({ host: 'ghe.corp', scope: 'mismatch' });
  });

  it('is misconfigured for a half override, without a lookup', async () => {
    const lookup = vi.fn().mockResolvedValue(cred());
    expect(
      await platformCredentialFor(
        { baseUrl: 'https://ghe.corp', installationHost: null },
        INSTANCE,
        lookup
      )
    ).toEqual({
      scope: 'misconfigured',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up a data-residency tenant that is not the instance by its web host', async () => {
    const lookup = vi.fn().mockResolvedValue(cred({ host: 'acme.ghe.com' }));
    const r = await platformCredentialFor(
      {
        apiUrl: 'https://api.acme.ghe.com',
        baseUrl: 'https://acme.ghe.com',
        installationHost: null,
      },
      INSTANCE,
      lookup
    );
    expect(lookup).toHaveBeenCalledWith('acme.ghe.com');
    expect(r.scope).toBe('host');
  });

  it('treats github.com as another host when the instance is a GHE, with its own set', async () => {
    const ghe = { ...INSTANCE, apiUrl: 'https://ghe.corp/api/v3', baseUrl: 'https://ghe.corp' };
    const lookup = vi.fn().mockResolvedValue(cred({ host: 'github.com' }));
    const r = await platformCredentialFor(
      { apiUrl: 'https://api.github.com', baseUrl: 'https://github.com', installationHost: null },
      ghe,
      lookup
    );
    expect(lookup).toHaveBeenCalledWith('github.com');
    expect(r.scope).toBe('host');
  });
});
