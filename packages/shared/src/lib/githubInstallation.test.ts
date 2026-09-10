import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearInstallationTokenCache,
  GitHubTokenMissingError,
  resolveGitHubToken,
} from './githubInstallation.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

function config(over: Partial<ResolvedGitHubConfig> = {}): ResolvedGitHubConfig {
  return {
    apiUrl: 'https://api.github.com',
    appId: '111',
    appInstallationId: 'default-install',
    appPrivateKey: PEM,
    baseUrl: 'https://github.com',
    ...over,
  } as ResolvedGitHubConfig;
}

/** One token per installation id, so a response identifies which was asked for. */
function mintingFetch() {
  const calls: string[] = [];
  const spy = vi.fn(async (url: string) => {
    calls.push(url);
    const installation = url.match(/installations\/([^/]+)\//)?.[1] ?? 'unknown';
    return new Response(
      JSON.stringify({
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        token: `tok-${installation}`,
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 201 }
    );
  });
  vi.stubGlobal('fetch', spy);
  return { calls, spy };
}

beforeEach(() => {
  clearInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installation token resolution', () => {
  it('mints against the installation the caller names, not the singleton', async () => {
    const { calls } = mintingFetch();
    await expect(resolveGitHubToken(config(), { installationId: 'acme-install' })).resolves.toBe(
      'tok-acme-install'
    );
    expect(calls[0]).toContain('/app/installations/acme-install/access_tokens');
  });

  it('falls back to the singleton installation when the caller names none', async () => {
    mintingFetch();
    await expect(resolveGitHubToken(config())).resolves.toBe('tok-default-install');
  });

  it('caches per installation rather than in one shared slot', async () => {
    // The regression this exists for: a single cached token meant two
    // installations evicted each other, so every alternating call paid a fresh
    // round-trip to GitHub — and under load, the rate limit.
    const { spy } = mintingFetch();
    const a = { installationId: 'install-a' };
    const b = { installationId: 'install-b' };

    await resolveGitHubToken(config(), a);
    await resolveGitHubToken(config(), b);
    await resolveGitHubToken(config(), a);
    await resolveGitHubToken(config(), b);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never serves one installation the token of another', async () => {
    mintingFetch();
    const a = await resolveGitHubToken(config(), { installationId: 'install-a' });
    const b = await resolveGitHubToken(config(), { installationId: 'install-b' });
    expect(a).toBe('tok-install-a');
    expect(b).toBe('tok-install-b');
  });

  it('treats the same installation id on a different host as a different installation', async () => {
    const { spy } = mintingFetch();
    await resolveGitHubToken(config(), { apiUrl: 'https://api.github.com', installationId: '7' });
    await resolveGitHubToken(config(), {
      apiUrl: 'https://ghe.example.com/api/v3',
      installationId: '7',
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the App private key rotates', async () => {
    const { spy } = mintingFetch();
    await resolveGitHubToken(config(), { installationId: 'install-a' });
    const { privateKey: rotated } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rotatedPem = rotated.export({ format: 'pem', type: 'pkcs8' }).toString();
    await resolveGitHubToken(config({ appPrivateKey: rotatedPem }), {
      installationId: 'install-a',
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-mints once a cached token reaches its safety margin', async () => {
    const calls: string[] = [];
    // Expires in 30s — inside the 60s margin, so it must never be served.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            expires_at: new Date(Date.now() + 30_000).toISOString(),
            token: 'about-to-expire',
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 201 }
        );
      })
    );
    await resolveGitHubToken(config(), { installationId: 'install-a' });
    await resolveGitHubToken(config(), { installationId: 'install-a' });
    expect(calls).toHaveLength(2);
  });

  it('honours authMode pat even when the App is fully configured', async () => {
    const { spy } = mintingFetch();
    await expect(
      resolveGitHubToken(config({ authMode: 'pat', token: 'ghp_x' }), {
        installationId: 'install-a',
      })
    ).resolves.toBe('ghp_x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the PAT when no App is configured', async () => {
    await expect(
      resolveGitHubToken(
        config({ appId: null, appInstallationId: null, appPrivateKey: null, token: 'ghp_x' })
      )
    ).resolves.toBe('ghp_x');
  });

  it('throws the typed missing-token error when nothing is configured', async () => {
    await expect(
      resolveGitHubToken(
        config({ appId: null, appInstallationId: null, appPrivateKey: null, token: null })
      )
    ).rejects.toBeInstanceOf(GitHubTokenMissingError);
  });

  it('surfaces a GitHub rejection rather than caching a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'Bad credentials' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 401,
          })
      )
    );
    await expect(resolveGitHubToken(config(), { installationId: 'x' })).rejects.toThrow(
      /installation token request failed: 401/
    );
  });
});
