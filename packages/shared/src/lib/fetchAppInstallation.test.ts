import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAppInstallation, PlatformCredentialHostError } from './githubInstallation.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const config = {
  apiUrl: 'https://api.github.com',
  appId: '1',
  appPrivateKey: privateKey,
  credentialHost: 'github.com',
} as unknown as ResolvedGitHubConfig;

const reply = (status: number, body: unknown = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

afterEach(() => vi.unstubAllGlobals());

describe('fetchAppInstallation', () => {
  it('reports active, suspended and deleted from what GitHub answers', async () => {
    reply(200, { account: { login: 'acme' }, suspended_at: null });
    await expect(fetchAppInstallation(config, '7')).resolves.toEqual({
      accountLogin: 'acme',
      state: 'active',
    });
    reply(200, { account: { login: 'acme' }, suspended_at: '2026-01-01T00:00:00Z' });
    await expect(fetchAppInstallation(config, '7')).resolves.toMatchObject({ state: 'suspended' });
    reply(404);
    await expect(fetchAppInstallation(config, '7')).resolves.toMatchObject({ state: 'deleted' });
  });

  it('asks the App endpoint with the App JWT', async () => {
    reply(200, {});
    await fetchAppInstallation(config, '7');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.github.com/app/installations/7');
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('throws on any other status, without App credentials, and never sends the JWT to another host', async () => {
    reply(500);
    await expect(fetchAppInstallation(config, '7')).rejects.toThrow('500');
    await expect(fetchAppInstallation({ ...config, appPrivateKey: null }, '7')).rejects.toThrow();
    reply(200, {});
    await expect(
      fetchAppInstallation(config, '7', 'https://ghe.corp/api/v3')
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
