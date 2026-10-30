import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearInstallationTokenCache,
  fetchGitHubAppIdentity,
  GitHubTokenMissingError,
  PlatformCredentialHostError,
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

  it('refuses to mint for an installation id on any non-instance host', async () => {
    const { spy } = mintingFetch();
    await expect(
      resolveGitHubToken(config(), {
        apiUrl: 'https://ghe.example.com/api/v3',
        installationId: '7',
      })
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    expect(spy).not.toHaveBeenCalled();
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

describe('the platform credential and a foreign API host', () => {
  const FOREIGN = 'https://ghe.corp/api/v3';

  it('posts no App JWT to another host without an installation id', async () => {
    const { spy } = mintingFetch();
    await expect(resolveGitHubToken(config(), { apiUrl: FOREIGN })).rejects.toBeInstanceOf(
      PlatformCredentialHostError
    );
    await expect(
      resolveGitHubToken(config(), { apiUrl: FOREIGN, installationId: null })
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns no PAT for another host, even with an installation id', async () => {
    const { spy } = mintingFetch();
    const pat = config({ authMode: 'pat', token: 'pat-secret' });
    await expect(
      resolveGitHubToken(pat, { apiUrl: FOREIGN, installationId: '7' })
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    await expect(resolveGitHubToken(pat, { apiUrl: FOREIGN })).rejects.toBeInstanceOf(
      PlatformCredentialHostError
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts no App JWT to another host even with an installation id, in App mode', async () => {
    const { spy } = mintingFetch();
    await expect(
      resolveGitHubToken(config(), { apiUrl: FOREIGN, installationId: '7' })
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("mints a repository's own installation on the instance host", async () => {
    const { calls } = mintingFetch();
    await expect(
      resolveGitHubToken(config(), { apiUrl: 'https://api.github.com', installationId: '7' })
    ).resolves.toBe('tok-7');
    expect(calls[0]).toBe('https://api.github.com/app/installations/7/access_tokens');
  });

  it('treats a spelling of the instance API host as the instance', async () => {
    mintingFetch();
    await expect(
      resolveGitHubToken(config({ authMode: 'pat', token: 'pat' }), {
        apiUrl: 'https://API.github.com/',
      })
    ).resolves.toBe('pat');
  });
});

describe("a host's own credential set", () => {
  // The set's config carries the host's API; the guard checks against it.
  const HOST_API = 'https://ghe.corp/api/v3';
  const hostSet = (over: Partial<ResolvedGitHubConfig> = {}) =>
    config({
      apiUrl: HOST_API,
      appInstallationId: null,
      baseUrl: 'https://ghe.corp',
      ...over,
    });

  it("mints a host's installation at that host's API with that host's App", async () => {
    const { calls, spy } = mintingFetch();
    await expect(
      resolveGitHubToken(hostSet(), { apiUrl: HOST_API, installationId: '7' })
    ).resolves.toBe('tok-7');
    expect(calls[0]).toBe('https://ghe.corp/api/v3/app/installations/7/access_tokens');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses the host set's credential on the instance's host, and on any third host", async () => {
    const { spy } = mintingFetch();
    const set = hostSet({ authMode: 'pat', token: 'host-pat' });
    for (const apiUrl of ['https://api.github.com', 'https://other.corp/api/v3']) {
      await expect(resolveGitHubToken(set, { apiUrl })).rejects.toBeInstanceOf(
        PlatformCredentialHostError
      );
      await expect(resolveGitHubToken(set, { apiUrl, installationId: '7' })).rejects.toBeInstanceOf(
        PlatformCredentialHostError
      );
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the same numeric installation id on two hosts apart in the token cache', async () => {
    const { calls } = mintingFetch();
    await resolveGitHubToken(config(), { apiUrl: 'https://api.github.com', installationId: '7' });
    await resolveGitHubToken(hostSet(), { apiUrl: HOST_API, installationId: '7' });
    expect(calls).toEqual([
      'https://api.github.com/app/installations/7/access_tokens',
      'https://ghe.corp/api/v3/app/installations/7/access_tokens',
    ]);
  });

  it('has no singleton installation: an App-only host without an installation id is missing a token', async () => {
    mintingFetch();
    await expect(resolveGitHubToken(hostSet(), { apiUrl: HOST_API })).rejects.toBeInstanceOf(
      GitHubTokenMissingError
    );
  });
});

describe('the credential set carries its own host', () => {
  it('refuses a target on a different host than the set was minted for, whatever apiUrl it holds', async () => {
    const { spy } = mintingFetch();
    // A set for ghe.corp whose own apiUrl was (wrongly) left at the instance's.
    const set = config({ credentialHost: 'ghe.corp' });
    await expect(
      resolveGitHubToken(set, { apiUrl: 'https://api.github.com', installationId: '7' })
    ).rejects.toBeInstanceOf(PlatformCredentialHostError);
    await expect(resolveGitHubToken(set, { installationId: '7' })).rejects.toBeInstanceOf(
      PlatformCredentialHostError
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows a target on the set's own host", async () => {
    mintingFetch();
    const set = config({ apiUrl: 'https://ghe.corp/api/v3', credentialHost: 'ghe.corp' });
    await expect(
      resolveGitHubToken(set, { apiUrl: 'https://ghe.corp/api/v3', installationId: '7' })
    ).resolves.toBe('tok-7');
  });
});

describe('fetchGitHubAppIdentity', () => {
  const answer = (status: number, body: unknown = {}) =>
    vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })
    );
  const ask = (fetchImpl: ReturnType<typeof answer>, apiUrl = 'https://api.github.com') =>
    fetchGitHubAppIdentity({
      apiUrl,
      appId: '222',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      privateKey: PEM,
    });

  it('returns the id and slug GitHub reports, after asking GET /app with an App JWT', async () => {
    const f = answer(200, { id: 222, slug: 'approver' });
    expect(await ask(f, 'https://ghe.example.com/api/v3/')).toEqual({
      id: '222',
      ok: true,
      slug: 'approver',
    });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://ghe.example.com/api/v3/app');
    expect(init?.redirect).toBe('error');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? '';
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(Buffer.from(auth.split('.')[1] ?? '', 'base64url').toString());
    expect(payload.iss).toBe('222');
  });

  it.each([401, 403, 404])('is rejected on a %i', async (status) => {
    expect(await ask(answer(status))).toEqual({ ok: false, reason: 'rejected' });
  });

  it('is rejected when the answer is not an App', async () => {
    expect(await ask(answer(200, { login: 'someone' }))).toEqual({ ok: false, reason: 'rejected' });
  });

  it('is unreachable on a server error or a network failure, and never carries their text', async () => {
    expect(await ask(answer(500))).toEqual({ ok: false, reason: 'unreachable' });
    const boom = vi.fn(async () => {
      throw new Error('ECONNRESET secret-detail');
    });
    const out = await ask(boom as unknown as ReturnType<typeof answer>);
    expect(out).toEqual({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(out)).not.toContain('secret-detail');
  });

  it('is rejected, without calling the host, for a key that cannot sign', async () => {
    const f = answer(200, { id: 222, slug: 'approver' });
    const out = await fetchGitHubAppIdentity({
      apiUrl: 'https://api.github.com',
      appId: '222',
      fetchImpl: f as unknown as typeof fetch,
      privateKey: 'not a key',
    });
    expect(out).toEqual({ ok: false, reason: 'rejected' });
    expect(f).not.toHaveBeenCalled();
  });
});
