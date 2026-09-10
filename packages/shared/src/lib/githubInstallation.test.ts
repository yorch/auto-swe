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
    appInstallationId: '900001',
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
    await expect(resolveGitHubToken(config(), { installationId: '900002' })).resolves.toBe(
      'tok-900002'
    );
    expect(calls[0]).toContain('/app/installations/900002/access_tokens');
  });

  it('falls back to the singleton installation when the caller names none', async () => {
    mintingFetch();
    await expect(resolveGitHubToken(config())).resolves.toBe('tok-900001');
  });

  it('caches per installation rather than in one shared slot', async () => {
    // The regression this exists for: a single cached token meant two
    // installations evicted each other, so every alternating call paid a fresh
    // round-trip to GitHub — and under load, the rate limit.
    const { spy } = mintingFetch();
    const a = { installationId: '900003' };
    const b = { installationId: '900004' };

    await resolveGitHubToken(config(), a);
    await resolveGitHubToken(config(), b);
    await resolveGitHubToken(config(), a);
    await resolveGitHubToken(config(), b);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never serves one installation the token of another', async () => {
    mintingFetch();
    const a = await resolveGitHubToken(config(), { installationId: '900003' });
    const b = await resolveGitHubToken(config(), { installationId: '900004' });
    expect(a).toBe('tok-900003');
    expect(b).toBe('tok-900004');
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
    await resolveGitHubToken(config(), { installationId: '900003' });
    const { privateKey: rotated } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rotatedPem = rotated.export({ format: 'pem', type: 'pkcs8' }).toString();
    await resolveGitHubToken(config({ appPrivateKey: rotatedPem }), {
      installationId: '900003',
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
    await resolveGitHubToken(config(), { installationId: '900003' });
    await resolveGitHubToken(config(), { installationId: '900003' });
    expect(calls).toHaveLength(2);
  });

  it('honours authMode pat even when the App is fully configured', async () => {
    const { spy } = mintingFetch();
    await expect(
      resolveGitHubToken(config({ authMode: 'pat', token: 'ghp_x' }), {
        installationId: '900003',
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

  it('refuses a non-numeric installation id rather than interpolating it', async () => {
    // GitHub installation ids are numeric. The per-installation rows are
    // validated at the API, but the singleton `appInstallationId` is only
    // length-checked, and a value with slashes would redirect the App JWT to a
    // different path on the configured host.
    const spy = mintingFetch().spy;
    await expect(resolveGitHubToken(config({ appInstallationId: '1/../../evil' }))).rejects.toThrow(
      /must be numeric/
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not double the slash when the api base ends in one', async () => {
    const { spy } = mintingFetch();
    await resolveGitHubToken(config({ apiUrl: 'https://ghe.example.com/api/v3/' }), {
      apiUrl: 'https://ghe.example.com/api/v3/',
      installationId: '900007',
    });
    expect(spy.mock.calls[0][0]).toBe(
      'https://ghe.example.com/api/v3/app/installations/900007/access_tokens'
    );
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
    await expect(resolveGitHubToken(config(), { installationId: '900009' })).rejects.toThrow(
      /installation token request failed: 401/
    );
  });
});
