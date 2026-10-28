import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearInstallationTokenCache,
  GitHubTokenMissingError,
  PlatformCredentialHostError,
  RepositoryNotVisibleError,
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

describe('repository-scoped installation tokens', () => {
  /** Echoes the request body into the token so a response identifies what was asked for. */
  function bodyEchoingFetch() {
    const bodies: (string | undefined)[] = [];
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      bodies.push(body);
      return new Response(
        JSON.stringify({
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          token: `tok-${body ?? 'unscoped'}`,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 201 }
      );
    });
    vi.stubGlobal('fetch', spy);
    return { bodies, spy };
  }

  it('restricts the token to the named repositories', async () => {
    const { bodies } = bodyEchoingFetch();
    await resolveGitHubToken(config(), { repositories: ['payments-api'] });
    expect(JSON.parse(bodies[0] ?? 'null')).toEqual({ repositories: ['payments-api'] });
  });

  it('sends no body when no repositories are named', async () => {
    const { bodies } = bodyEchoingFetch();
    await resolveGitHubToken(config());
    await resolveGitHubToken(config(), { repositories: [] });
    expect(bodies).toEqual([undefined]);
  });

  it('never serves a narrow token for a wider request, or the reverse', async () => {
    const { spy } = bodyEchoingFetch();
    const narrow = await resolveGitHubToken(config(), { repositories: ['a'] });
    const wide = await resolveGitHubToken(config());
    const other = await resolveGitHubToken(config(), { repositories: ['b'] });
    const both = await resolveGitHubToken(config(), { repositories: ['a', 'b'] });
    expect(new Set([narrow, wide, other, both]).size).toBe(4);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('caches a scoped token, whatever order or case the names arrive in', async () => {
    const { spy } = bodyEchoingFetch();
    await resolveGitHubToken(config(), { repositories: ['a', 'B'] });
    await resolveGitHubToken(config(), { repositories: ['b', 'A'] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sends repository names as given, and lowercases only for the cache key', async () => {
    const { bodies } = bodyEchoingFetch();
    await resolveGitHubToken(config(), { repositories: ['Payments-API'] });
    expect(JSON.parse(bodies[0] ?? 'null')).toEqual({ repositories: ['Payments-API'] });
  });

  const NOT_ACCESSIBLE =
    'There is at least one repository that does not exist or is not accessible to the parent installation.';
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', ...headers },
      status,
    });
  const minted = (token: string) =>
    json(201, { expires_at: new Date(Date.now() + 3_600_000).toISOString(), token });

  /** Routes by method, path and mint body, recording every call. */
  function githubDouble(
    handler: (req: { url: string; method: string; auth: string; body: unknown }) => Response
  ) {
    const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const req = {
        auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        method: init?.method ?? 'GET',
        url,
      };
      calls.push(req);
      return handler(req);
    });
    vi.stubGlobal('fetch', spy);
    return { calls, spy };
  }

  it('raises a typed error when GitHub says the repository is not accessible and none can be found', async () => {
    githubDouble((req) => {
      if (req.method === 'POST') {
        return req.body === undefined
          ? minted('tok-UNSCOPED')
          : json(422, { message: NOT_ACCESSIBLE });
      }
      return json(404, {});
    });
    const err = await resolveGitHubToken(config(), {
      installationId: '900009',
      owner: 'acme',
      repositories: ['gone'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryNotVisibleError);
    expect(String(err)).toContain('gone');
    expect(String(err)).toContain('900009');
  });

  it('raises the typed error without a lookup when the caller gave no owner', async () => {
    const { calls } = githubDouble(() => json(422, { message: NOT_ACCESSIBLE }));
    const err = await resolveGitHubToken(config(), {
      installationId: '900009',
      repositories: ['gone'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryNotVisibleError);
    expect(calls).toHaveLength(1);
  });

  it('treats any other 422 as an ordinary failure, without echoing the response', async () => {
    // GitHub also answers 422 when the endpoint has been spammed.
    githubDouble(() => json(422, { message: 'Validation Failed: secret-ish detail' }));
    const err = await resolveGitHubToken(config(), {
      installationId: '900009',
      owner: 'acme',
      repositories: ['fine'],
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RepositoryNotVisibleError);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('422');
    expect(String(err)).not.toContain('secret-ish');
  });

  describe('a repository renamed since its name was stored', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
    });

    const renamed = () =>
      githubDouble((req) => {
        if (req.method === 'POST') {
          const body = req.body as
            | { repositories?: string[]; repository_ids?: number[] }
            | undefined;
          if (body?.repositories) {
            return json(422, { message: NOT_ACCESSIBLE });
          }
          return minted(body?.repository_ids ? 'tok-by-id' : 'tok-UNSCOPED');
        }
        if (req.url.endsWith('/repos/acme/old-name')) {
          return new Response(null, {
            headers: { Location: 'https://api.github.com/repositories/42' },
            status: 301,
          });
        }
        if (req.url.endsWith('/repositories/42')) {
          return json(200, { full_name: 'acme/new-name', id: 42, name: 'new-name' });
        }
        return json(404, {});
      });
    const target = { installationId: '900010', owner: 'acme', repositories: ['old-name'] };

    it('mints again by immutable id and returns only the id-scoped token', async () => {
      const { calls } = renamed();
      await expect(resolveGitHubToken(config(), target)).resolves.toBe('tok-by-id');
      const mints = calls.filter((c) => c.method === 'POST').map((c) => c.body);
      expect(mints).toEqual([{ repositories: ['old-name'] }, undefined, { repository_ids: [42] }]);
      // The unscoped token authenticates the lookup, and goes nowhere else.
      const lookup = calls.filter((c) => c.method === 'GET');
      expect(lookup.length).toBeGreaterThan(0);
      expect(lookup[0].auth).toBe('Bearer tok-UNSCOPED');
    });

    it('warns with the stale and the current name, and never a token', async () => {
      renamed();
      await resolveGitHubToken(config(), target);
      const line = warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(line).toContain('old-name');
      expect(line).toContain('new-name');
      expect(line).not.toContain('tok-');
    });

    it('keeps serving the id-scoped token from the cache under the stored name', async () => {
      const { spy } = renamed();
      await resolveGitHubToken(config(), target);
      const calls = spy.mock.calls.length;
      await expect(resolveGitHubToken(config(), target)).resolves.toBe('tok-by-id');
      expect(spy.mock.calls.length).toBe(calls);
    });

    it('is not-visible, and mints no id token, when GitHub reports another owner', async () => {
      // A transfer to another account: the id now belongs elsewhere.
      const { calls } = githubDouble((req) => {
        if (req.method === 'POST') {
          return req.body === undefined
            ? minted('tok-UNSCOPED')
            : json(422, { message: NOT_ACCESSIBLE });
        }
        return json(200, { full_name: 'elsewhere/old-name', id: 42, name: 'old-name' });
      });
      const err = await resolveGitHubToken(config(), target).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepositoryNotVisibleError);
      expect(calls.some((c) => (c.body as { repository_ids?: unknown })?.repository_ids)).toBe(
        false
      );
    });

    it('sends the token to no other origin when the lookup redirects away', async () => {
      const { calls } = githubDouble((req) => {
        if (req.method === 'POST') {
          return req.body === undefined
            ? minted('tok-UNSCOPED')
            : json(422, { message: NOT_ACCESSIBLE });
        }
        return new Response(null, {
          headers: { Location: 'https://evil.example/repositories/42' },
          status: 301,
        });
      });
      const err = await resolveGitHubToken(config(), target).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RepositoryNotVisibleError);
      expect(calls.filter((c) => c.url.startsWith('https://evil.example'))).toEqual([]);
    });

    it.each([500, 403])(
      'treats a lookup answering %i as an ordinary, retryable failure',
      async (status) => {
        githubDouble((req) => {
          if (req.method === 'POST') {
            return req.body === undefined
              ? minted('tok-UNSCOPED')
              : json(422, { message: NOT_ACCESSIBLE });
          }
          return json(status, { message: 'nope' });
        });
        const err = await resolveGitHubToken(config(), target).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RepositoryNotVisibleError);
        expect(String(err)).toContain(String(status));
      }
    );

    it('is not-visible when the id mint is refused too (not selected for the App)', async () => {
      githubDouble((req) => {
        if (req.method === 'POST') {
          const body = req.body as { repository_ids?: number[] } | undefined;
          return body === undefined
            ? minted('tok-UNSCOPED')
            : json(422, { message: NOT_ACCESSIBLE });
        }
        return req.url.endsWith('/repos/acme/old-name')
          ? json(200, { full_name: 'acme/old-name', id: 42, name: 'old-name' })
          : json(404, {});
      });
      const err = await resolveGitHubToken(config(), target).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepositoryNotVisibleError);
      expect(String(err)).not.toContain('tok-UNSCOPED');
    });
  });

  it('leaves a 422 on an unscoped request a plain error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 422 }))
    );
    const err = await resolveGitHubToken(config()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RepositoryNotVisibleError);
    expect(err).toBeInstanceOf(Error);
  });

  it('does not narrow a PAT', async () => {
    const { spy } = bodyEchoingFetch();
    await expect(
      resolveGitHubToken(config({ appId: null, authMode: 'pat', token: 'ghp_pat' }), {
        repositories: ['a'],
      })
    ).resolves.toBe('ghp_pat');
    expect(spy).not.toHaveBeenCalled();
  });
});
