import { generateKeyPairSync } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: () => '',
  encryptSecret: (s: string) => ({
    authTag: new Uint8Array([1]),
    ciphertext: new TextEncoder().encode(`sealed:${s}`),
    keyVersion: 1,
    lastFour: s.trimEnd().slice(-4),
    nonce: new Uint8Array([3]),
  }),
}));

const resolveGitHubConfig = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveFigmaConfig: vi.fn(),
  resolveGitHubConfig: () => resolveGitHubConfig(),
  resolveIssueTrackerConfig: vi.fn(),
  resolveKnowledgeBaseConfig: vi.fn(),
  resolvePublicUrl: () => 'https://gw.example.com',
  resolveSlackConfig: vi.fn(),
  resolveWebUrl: () => 'https://app.example.com',
  resolveWorkflowDefaults: vi.fn(),
}));

const { githubAppManifestRoutes } = await import('./githubAppManifest.js');
const { hostBinding } = await import('../lib/githubAppManifest.js');

const AUTH = { authorization: 'Bearer fake-jwt' };
const START = '/api/v1/integrations/github-app-manifest';
const CALLBACK = '/api/v1/integrations/github-app-manifest/callback';
const COOKIE = 'auto_swe_github_app_manifest';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const DOTCOM = {
  apiUrl: 'https://api.github.com',
  appId: null,
  baseUrl: 'https://github.com',
  webhookSecret: null,
};

function conversion(over: Record<string, unknown> = {}) {
  return {
    client_id: 'Iv23.abc',
    client_secret: 'client-secret-value',
    html_url: 'https://github.com/apps/auto-swe-acme',
    id: 4242,
    pem: PEM,
    slug: 'auto-swe-acme',
    webhook_secret: 'gh-generated-secret',
    ...over,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

async function buildApp(role: string, fetchImpl: typeof fetch) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifyCookie);
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    gitHubConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(
        async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
          ...args.create,
          appInstallationId: null,
          authMode: null,
          baseUrl: null,
        })
      ),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ADMIN' }) },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    // A readable stand-in for the signed state: `state|<purpose>|<sub>|<nonce>`.
    signOAuthState: (sub: string, purpose: string, nonce?: string) =>
      `state|${purpose}|${sub}|${nonce ?? ''}`,
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
    verifyOAuthState: (token: string, purpose: string) => {
      const [kind, minted, sub, nonce] = token.split('|');
      if (kind !== 'state' || minted !== purpose) {
        throw new Error('bad state');
      }
      return { sub, ...(nonce ? { nonce } : {}) };
    },
  } as unknown as never);
  await app.register(githubAppManifestRoutes, { fetchImpl, prefix: '/api/v1/integrations' });
  await app.ready();
  return { app, prisma };
}

describe('githubAppManifestRoutes', () => {
  const calls: FetchCall[] = [];
  let respond: (call: FetchCall) => Response;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { init: init ?? {}, url: String(url) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;

  let admin: Awaited<ReturnType<typeof buildApp>>;
  let engineer: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    admin = await buildApp('ADMIN', fakeFetch);
    engineer = await buildApp('ENGINEER', fakeFetch);
  });
  afterAll(async () => {
    await admin.app.close();
    await engineer.app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM });
    admin.prisma.user.findUnique.mockResolvedValue({ isActive: true, role: 'ADMIN' });
    respond = (call) =>
      call.url.endsWith('/conversions')
        ? Response.json(conversion(), { status: 201 })
        : new Response('{}', { status: 200 });
  });

  async function start(body: object = {}) {
    const res = await admin.app.inject({
      headers: AUTH,
      method: 'POST',
      payload: body,
      url: START,
    });
    const cookie = res.cookies.find((c) => c.name === COOKIE);
    const data = JSON.parse(res.payload).data as {
      action: string;
      manifest: Record<string, unknown>;
    };
    return { cookie, data, res, state: new URL(data?.action ?? 'x:').searchParams.get('state') };
  }

  async function callback(query: Record<string, string>, cookie?: string) {
    return admin.app.inject({
      cookies: cookie ? { [COOKIE]: cookie } : {},
      method: 'GET',
      url: `${CALLBACK}?${new URLSearchParams(query)}`,
    });
  }

  it('refuses a non-ADMIN the start of the flow', async () => {
    const res = await engineer.app.inject({ headers: AUTH, method: 'POST', url: START });
    expect(res.statusCode).toBe(403);
  });

  it('builds the manifest, a state bound to this browser and host, and the form action', async () => {
    const { cookie, data, res, state } = await start({ name: 'auto-swe acme', org: 'acme' });
    expect(res.statusCode).toBe(200);
    expect(
      data.action.startsWith('https://github.com/organizations/acme/settings/apps/new?state=')
    ).toBe(true);
    expect(state?.startsWith('state|github-app-manifest|admin-1|')).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.secure).toBe(true);
    expect(cookie?.path).toBe(CALLBACK);
    expect(state?.endsWith(cookie?.value ?? 'missing')).toBe(true);
    expect(cookie?.value.split('.')[1]).toBe(hostBinding('https://api.github.com'));
    expect(data.manifest).toMatchObject({
      hook_attributes: { active: true, url: 'https://gw.example.com/api/v1/webhooks/git' },
      name: 'auto-swe acme',
      public: false,
      redirect_url: `https://gw.example.com${CALLBACK}`,
      setup_url: 'https://app.example.com/admin/integrations',
      url: 'https://app.example.com',
    });
    expect(data.manifest.default_permissions).toMatchObject({
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
  });

  it('posts to the Enterprise host when one is configured', async () => {
    resolveGitHubConfig.mockResolvedValue({
      ...DOTCOM,
      apiUrl: 'https://ghe.corp/api/v3',
      baseUrl: 'https://ghe.corp',
    });
    const { data } = await start();
    expect(data.action.startsWith('https://ghe.corp/settings/apps/new?state=')).toBe(true);
  });

  it('refuses to start while an App is configured, or when the web and API hosts differ', async () => {
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM, appId: '1' });
    expect((await start()).res.statusCode).toBe(409);
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM, apiUrl: 'https://ghe.corp/api/v3' });
    expect((await start()).res.statusCode).toBe(409);
  });

  it('refuses a malformed organization or App name', async () => {
    expect((await start({ org: 'acme/../x' })).res.statusCode).toBe(400);
    expect((await start({ name: 'x'.repeat(40) })).res.statusCode).toBe(400);
  });

  it('exchanges the code, stores the App sealed, audits it, and sends the browser to install', async () => {
    const { cookie, state } = await start();
    const res = await callback({ code: 'abc123', state: state ?? '' }, cookie?.value);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://github.com/apps/auto-swe-acme/installations/new');
    expect(res.cookies.find((c) => c.name === COOKIE)?.value).toBe('');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app-manifests/abc123/conversions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');

    const write = admin.prisma.gitHubConfig.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(write.update.appId).toBe('4242');
    expect(write.update.appClientId).toBe('Iv23.abc');
    // Secrets are written only as envelope columns, never as plaintext fields.
    expect(write.update).not.toHaveProperty('appPrivateKey');
    expect(write.update).not.toHaveProperty('appClientSecret');
    expect(new TextDecoder().decode(write.update.appPrivateKeyCiphertext as Uint8Array)).toBe(
      `sealed:${PEM}`
    );
    expect(new TextDecoder().decode(write.update.webhookSecretCiphertext as Uint8Array)).toBe(
      'sealed:gh-generated-secret'
    );

    const audit = admin.prisma.configAuditLog.create.mock.calls[0][0] as {
      data: { actorId: string; afterJson: Record<string, unknown>; entityType: string };
    };
    expect(audit.data.actorId).toBe('admin-1');
    expect(audit.data.entityType).toBe('GitHubConfig');
    expect(audit.data.afterJson.via).toBe('github-app-manifest');
    expect(JSON.stringify(audit.data)).not.toContain('client-secret-value');
    expect(JSON.stringify(audit.data)).not.toContain('PRIVATE KEY');
  });

  it('keeps an existing webhook secret and tells the new App to sign with it', async () => {
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM, webhookSecret: 'existing-secret' });
    const { cookie, state } = await start();
    const res = await callback({ code: 'abc123', state: state ?? '' }, cookie?.value);

    expect(res.headers.location).toBe('https://github.com/apps/auto-swe-acme/installations/new');
    const patch = calls.find((c) => c.url === 'https://api.github.com/app/hook/config');
    expect(patch?.init.method).toBe('PATCH');
    expect(patch?.init.redirect).toBe('error');
    expect(JSON.parse(String(patch?.init.body))).toEqual({
      content_type: 'json',
      secret: 'existing-secret',
    });
    const headers = (patch?.init.headers ?? {}) as Record<string, string>;
    expect(String(headers.Authorization)).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const write = admin.prisma.gitHubConfig.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(write.update).not.toHaveProperty('webhookSecretCiphertext');
  });

  it('stores the App but warns when the existing webhook secret cannot be set on it', async () => {
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM, webhookSecret: 'existing-secret' });
    respond = (call) =>
      call.url.endsWith('/conversions')
        ? Response.json(conversion(), { status: 201 })
        : new Response('{}', { status: 500 });
    const { cookie, state } = await start();
    const res = await callback({ code: 'abc123', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toBe(
      'https://app.example.com/admin/integrations?github_app_warning=WEBHOOK_SECRET_UNALIGNED'
    );
    expect(admin.prisma.gitHubConfig.upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses a callback without the browser cookie, with a forged state or a lesser flow', async () => {
    const { cookie, state } = await start();
    const noCookie = await callback({ code: 'abc', state: state ?? '' });
    expect(noCookie.headers.location).toContain('github_app_error=STATE_MISMATCH');
    const otherCookie = await callback({ code: 'abc', state: state ?? '' }, 'other.nonce');
    expect(otherCookie.headers.location).toContain('github_app_error=STATE_MISMATCH');
    const slackState = await callback(
      { code: 'abc', state: `state|slack-install|admin-1|${cookie?.value}` },
      cookie?.value
    );
    expect(slackState.headers.location).toContain('github_app_error=INVALID_STATE');
    const missing = await callback({ state: state ?? '' }, cookie?.value);
    expect(missing.headers.location).toContain('github_app_error=INVALID_CALLBACK');
    expect(calls).toHaveLength(0);
    expect(admin.prisma.gitHubConfig.upsert).not.toHaveBeenCalled();
  });

  it('refuses when the starter is no longer an active ADMIN', async () => {
    const { cookie, state } = await start();
    admin.prisma.user.findUnique.mockResolvedValue({ isActive: true, role: 'ENGINEER' });
    const res = await callback({ code: 'abc', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toContain('github_app_error=FORBIDDEN');
    expect(calls).toHaveLength(0);
  });

  it('never presents the code to a host other than the one the flow was started for', async () => {
    const { cookie, state } = await start();
    resolveGitHubConfig.mockResolvedValue({
      ...DOTCOM,
      apiUrl: 'https://evil.example/api/v3',
      baseUrl: 'https://evil.example',
    });
    const res = await callback({ code: 'abc', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toContain('github_app_error=HOST_CHANGED');
    expect(calls).toHaveLength(0);
  });

  it('refuses to replace an App configured while the flow was open', async () => {
    const { cookie, state } = await start();
    resolveGitHubConfig.mockResolvedValue({ ...DOTCOM, appId: '7' });
    const res = await callback({ code: 'abc', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toContain('github_app_error=APP_ALREADY_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('maps GitHub refusals and bad answers to fixed codes and stores nothing', async () => {
    const cases: [() => Response, string][] = [
      [() => new Response('{"message":"Not Found"}', { status: 404 }), 'CODE_REJECTED'],
      [() => new Response('oops', { status: 502 }), 'GITHUB_UNREACHABLE'],
      [() => Response.json(conversion({ pem: 'not a key' }), { status: 201 }), 'GITHUB_MALFORMED'],
      [() => Response.json(conversion({ slug: '../x' }), { status: 201 }), 'GITHUB_MALFORMED'],
    ];
    for (const [answer, code] of cases) {
      respond = answer;
      const { cookie, state } = await start();
      const res = await callback({ code: 'abc', state: state ?? '' }, cookie?.value);
      expect(res.headers.location).toBe(
        `https://app.example.com/admin/integrations?github_app_error=${code}`
      );
    }
    expect(admin.prisma.gitHubConfig.upsert).not.toHaveBeenCalled();
  });

  it('refuses a code that could change the request path', async () => {
    const { cookie, state } = await start();
    const res = await callback({ code: '../../app/hook', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toContain('github_app_error=CODE_REJECTED');
    expect(calls).toHaveLength(0);
  });

  it('falls back to the configured host when GitHub names an App page elsewhere', async () => {
    respond = () =>
      Response.json(conversion({ html_url: 'https://evil.example/apps/x' }), { status: 201 });
    const { cookie, state } = await start();
    const res = await callback({ code: 'abc', state: state ?? '' }, cookie?.value);
    expect(res.headers.location).toBe('https://github.com/apps/auto-swe-acme/installations/new');
  });
});
