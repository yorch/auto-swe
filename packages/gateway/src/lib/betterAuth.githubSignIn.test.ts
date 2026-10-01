import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  gh: {
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    oauthClientId: 'cid' as string | null,
    oauthClientSecret: 'sec' as string | null,
  },
  okta: {
    clientId: null as string | null,
    clientSecret: null as string | null,
    issuer: null as string | null,
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveBetterAuthConfig: () => ({
    baseUrl: 'https://gw.example.com',
    clientOrigin: 'https://web.example.com',
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
  }),
  resolveGitHubConfig: async () => state.gh,
  resolveGoogleOAuthConfig: async () => ({ clientId: null, clientSecret: null }),
  resolveOktaOAuthConfig: async () => state.okta,
}));

interface GenericPlugin {
  id: string;
  options?: { config?: Array<{ providerId: string }> };
}

async function build() {
  vi.resetModules();
  const fetchSpy = vi.fn(
    async (_url: unknown, _init?: unknown) => new Response('{}', { status: 404 })
  );
  vi.stubGlobal('fetch', fetchSpy);
  const mod = await import('./betterAuth.js');
  await mod.initAuth();
  const options = mod.getAuth().options;
  const generic = ((options.plugins ?? []) as GenericPlugin[]).filter(
    (plugin) => plugin.id === 'generic-oauth'
  );
  return {
    fetchSpy,
    genericPlugins: generic.length,
    genericProviderIds: generic.flatMap((plugin) =>
      (plugin.options?.config ?? []).map((config) => config.providerId)
    ),
    mod,
    providers: mod.configuredProviders(),
    socialGithub: Boolean(options.socialProviders?.github),
  };
}

function setGithub(partial: Partial<typeof state.gh>) {
  state.gh = { ...state.gh, ...partial };
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.gh = {
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
  };
  state.okta = { clientId: null, clientSecret: null, issuer: null };
  vi.restoreAllMocks();
});

describe('GitHub sign-in wiring', () => {
  it('registers the built-in provider and no generic plugin for github.com', async () => {
    const built = await build();

    expect(built.socialGithub).toBe(true);
    expect(built.genericPlugins).toBe(0);
    expect(built.providers.github).toBe(true);
  });

  it('registers GHE through generic OAuth, and not the built-in provider, for a GHE base URL', async () => {
    setGithub({ baseUrl: 'https://ghe.example.com' });

    const built = await build();

    expect(built.socialGithub).toBe(false);
    expect(built.genericProviderIds).toEqual(['github']);
    expect(built.providers.github).toBe(true);
  });

  it('puts GHE and Okta in one generic plugin so Okta sign-in is unchanged', async () => {
    setGithub({ baseUrl: 'https://ghe.example.com' });
    state.okta = { clientId: 'oid', clientSecret: 'osec', issuer: 'https://acme.okta.com' };

    const built = await build();

    expect(built.genericPlugins).toBe(1);
    expect([...built.genericProviderIds].sort()).toEqual(['github', 'okta']);
    expect(built.providers.okta).toBe(true);
  });

  it('keeps Okta alone in its generic plugin for github.com', async () => {
    state.okta = { clientId: 'oid', clientSecret: 'osec', issuer: 'https://acme.okta.com' };

    const built = await build();

    expect(built.genericProviderIds).toEqual(['okta']);
    expect(built.socialGithub).toBe(true);
  });

  it('registers no GitHub sign-in and hides the button when the base URL is invalid', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setGithub({ baseUrl: 'ftp://ghe.example.com' });

    const built = await build();

    expect(built.socialGithub).toBe(false);
    expect(built.genericPlugins).toBe(0);
    expect(built.providers.github).toBe(false);
  });

  it('does not let a saved empty base URL fall back to github.com', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setGithub({ baseUrl: '' });

    const built = await build();

    expect(built.socialGithub).toBe(false);
    expect(built.providers.github).toBe(false);
  });

  it('reports GitHub unavailable without a client secret in either mode', async () => {
    setGithub({ oauthClientSecret: null });
    expect((await build()).providers.github).toBe(false);

    setGithub({ baseUrl: 'https://ghe.example.com' });
    expect((await build()).providers.github).toBe(false);
  });
});

describe('GitHub sign-in wiring: restart semantics', () => {
  it('keeps the mode resolved at start when initAuth runs again with changed config', async () => {
    const built = await build();
    expect(built.providers.github).toBe(true);

    setGithub({ baseUrl: 'ftp://changed.example.com' });
    await built.mod.initAuth();

    expect(built.mod.configuredProviders().github).toBe(true);
  });
});

describe('GitHub login sync after sign-in', () => {
  async function runAccountHook(
    built: Awaited<ReturnType<typeof build>>,
    respond: (url: string) => Response
  ) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return respond(String(url));
      })
    );
    const hook = built.mod.getAuth().options.databaseHooks?.account?.create?.after;
    await hook?.({
      accessToken: 'ghe-token',
      providerId: 'github',
      userId: 'u1',
    } as unknown as Parameters<NonNullable<typeof hook>>[0]);
    return calls;
  }

  const profile = () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });

  it('sends the GHE token to the derived GHE API, never to api.github.com', async () => {
    setGithub({ baseUrl: 'https://ghe.example.com' });

    const calls = await runAccountHook(await build(), profile);

    expect(calls).toEqual(['https://ghe.example.com/api/v3/user']);
  });

  it('uses an explicit API URL as configured in GHE mode', async () => {
    setGithub({ apiUrl: 'https://api.ghe.example.com', baseUrl: 'https://ghe.example.com' });

    const calls = await runAccountHook(await build(), profile);

    expect(calls).toEqual(['https://api.ghe.example.com/user']);
  });

  it('keeps using the configured API URL for github.com', async () => {
    const calls = await runAccountHook(await build(), profile);

    expect(calls).toEqual(['https://api.github.com/user']);
  });
});
