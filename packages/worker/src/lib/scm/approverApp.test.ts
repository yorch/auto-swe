import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import {
  type ApproverClient,
  type ApproverDeps,
  approverBotLogin,
  findOwnApproval,
  getApproverClient,
  ownApprovals,
  submitApprovingReview,
} from './approverApp.js';
import type { RepoRef } from './types.js';

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const INSTALL_TOKEN = 'ghs_installation_token_secret';

const repo: RepoRef = { installationHost: null, organizationName: 'acme', repoName: 'payments' };
const approverConfig = { appId: '222', appSlug: 'Auto-SWE-Approver', privateKey: PRIVATE_KEY };
const instance = { apiUrl: 'https://api.github.com', appId: '111', baseUrl: 'https://github.com' };

const INSTALLATION = {
  id: 777,
  permissions: { metadata: 'read', pull_requests: 'write' },
  repository_selection: 'selected',
};

interface Call {
  route: string;
  params: Record<string, unknown>;
}

function httpError(status: number, message = 'host said no'): Error {
  return Object.assign(new Error(message), { status });
}

function harness(
  overrides: Partial<ApproverDeps> = {},
  handler: (call: Call) => unknown = (call) => {
    if (call.route === 'GET /app') {
      return { data: { id: 222, slug: 'auto-swe-approver' } };
    }
    if (call.route.startsWith('GET /repos/')) {
      return { data: INSTALLATION };
    }
    if (call.route === 'DELETE /installation/token') {
      return { data: {} };
    }
    if (call.route.startsWith('POST /app/installations/')) {
      return { data: { token: INSTALL_TOKEN } };
    }
    return { data: {} };
  }
) {
  const calls: Call[] = [];
  const created: { auth: string; baseUrl?: string }[] = [];
  const logs: unknown[][] = [];
  const deps: ApproverDeps = {
    createOctokit: (opts) => {
      created.push(opts);
      return {
        request: async (route: string, params: Record<string, unknown> = {}) => {
          calls.push({ params, route });
          const out = handler({ params, route });
          if (out instanceof Error) {
            throw out;
          }
          return out as { data: unknown };
        },
      };
    },
    hostsAllowed: async () => ({ ok: true }),
    loadApproverConfig: async () => approverConfig,
    loadGitHubConfig: async () => instance,
    now: () => new Date('2026-10-29T12:00:00Z'),
    ...overrides,
  };
  return { calls, created, deps, logs };
}

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split('.');
  const verify = createVerify('RSA-SHA256');
  verify.update(`${h}.${p}`);
  return {
    header: JSON.parse(Buffer.from(h as string, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p as string, 'base64url').toString()),
    valid: verify.verify(createPublicKey(PUBLIC_KEY), Buffer.from(s as string, 'base64url')),
  };
}

describe('approverBotLogin', () => {
  it('is the lower-cased slug with [bot]', () => {
    expect(approverBotLogin(approverConfig)).toBe('auto-swe-approver[bot]');
  });
});

describe('getApproverClient', () => {
  it('is not-configured without an approver App', async () => {
    const h = harness({ loadApproverConfig: async () => null });
    expect(await getApproverClient(repo, h.deps)).toEqual({ ok: false, reason: 'not-configured' });
    expect(h.created).toHaveLength(0);
  });

  it('refuses a repository on another host and sends nothing there', async () => {
    const h = harness();
    const other = {
      ...repo,
      apiUrl: 'https://ghe.example.com/api/v3',
      baseUrl: 'https://ghe.example.com',
    };
    expect(await getApproverClient(other, h.deps)).toEqual({ ok: false, reason: 'host-mismatch' });
    expect(h.created).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a half-overridden repository (web and API on different hosts)', async () => {
    const h = harness();
    const half = { ...repo, apiUrl: 'https://ghe.example.com/api/v3' };
    expect(await getApproverClient(half, h.deps)).toEqual({ ok: false, reason: 'host-mismatch' });
    expect(h.created).toHaveLength(0);
  });

  it('refuses a repository whose hosts are not approved', async () => {
    const h = harness({ hostsAllowed: async () => ({ ok: false, url: 'https://x' }) });
    expect(await getApproverClient(repo, h.deps)).toEqual({
      ok: false,
      reason: 'host-not-allowed',
    });
    expect(h.created).toHaveLength(0);
  });

  it('refuses when the approver App is the platform App', async () => {
    const h = harness({ loadGitHubConfig: async () => ({ ...instance, appId: '222' }) });
    expect(await getApproverClient(repo, h.deps)).toEqual({
      ok: false,
      reason: 'same-app-as-platform',
    });
    expect(h.created).toHaveLength(0);
  });

  it('is not-installed on a 404 from the installation lookup', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'auto-swe-approver' } }
        : call.route.startsWith('GET /repos/')
          ? httpError(404)
          : { data: {} }
    );
    expect(await getApproverClient(repo, h.deps)).toEqual({ ok: false, reason: 'not-installed' });
    expect(h.calls.some((c) => c.route.startsWith('POST /app/installations'))).toBe(false);
  });

  it('refuses with slug-mismatch when GitHub names another slug, and mints no token', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'someone-elses-app' } }
        : { data: INSTALLATION }
    );
    expect(await getApproverClient(repo, h.deps)).toEqual({
      ok: false,
      reason: 'slug-mismatch',
    });
    expect(h.calls.map((c) => c.route)).toEqual(['GET /app']);
  });

  it('compares the slug case-insensitively and caches nothing between calls', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'AUTO-SWE-APPROVER' } }
        : call.route.startsWith('POST')
          ? { data: { token: INSTALL_TOKEN } }
          : { data: INSTALLATION }
    );
    expect((await getApproverClient(repo, h.deps)).ok).toBe(true);
    expect((await getApproverClient(repo, h.deps)).ok).toBe(true);
    expect(h.calls.filter((c) => c.route === 'GET /app')).toHaveLength(2);
  });

  it('is key-invalid when GitHub rejects the App JWT', async () => {
    const h = harness({}, (call) => (call.route === 'GET /app' ? httpError(401) : { data: {} }));
    expect(await getApproverClient(repo, h.deps)).toEqual({ ok: false, reason: 'key-invalid' });
  });

  it('refuses an installation on every repository of the account', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'auto-swe-approver' } }
        : { data: { ...INSTALLATION, repository_selection: 'all' } }
    );
    expect(await getApproverClient(repo, h.deps)).toEqual({
      ok: false,
      reason: 'installation-too-broad',
    });
    expect(h.calls.some((c) => c.route.startsWith('POST /app/installations'))).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['unknown', 'something-else'],
  ] as const)('refuses an installation whose repository_selection is %s', async (_n, selection) => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'auto-swe-approver' } }
        : { data: { ...INSTALLATION, repository_selection: selection } }
    );
    expect(await getApproverClient(repo, h.deps)).toEqual({
      ok: false,
      reason: 'installation-too-broad',
    });
    expect(h.calls.some((c) => c.route.startsWith('POST /app/installations'))).toBe(false);
  });

  it.each([
    [{ contents: 'read', metadata: 'read', pull_requests: 'write' }],
    [{ metadata: 'write', pull_requests: 'write' }],
    [{ metadata: 'read', pull_requests: 'write', statuses: 'write' }],
    [undefined],
    ['write'],
  ] as const)(
    'refuses an installation holding permissions beyond pull requests: %j',
    async (permissions) => {
      const h = harness({}, (call) =>
        call.route === 'GET /app'
          ? { data: { id: 222, slug: 'auto-swe-approver' } }
          : { data: { ...INSTALLATION, permissions } }
      );
      expect(await getApproverClient(repo, h.deps)).toEqual({
        ok: false,
        reason: 'installation-too-broad',
      });
      expect(h.calls.some((c) => c.route.startsWith('POST /app/installations'))).toBe(false);
    }
  );

  it('accepts read access to pull requests and metadata alone', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'auto-swe-approver' } }
        : call.route.startsWith('POST')
          ? { data: { token: INSTALL_TOKEN } }
          : { data: { ...INSTALLATION, permissions: { metadata: 'read', pull_requests: 'read' } } }
    );
    expect((await getApproverClient(repo, h.deps)).ok).toBe(true);
  });

  it('release revokes the installation token with the token client and never throws', async () => {
    const h = harness();
    const result = await getApproverClient(repo, h.deps);
    if (!result.ok) {
      throw new Error('expected a client');
    }
    await result.client.release();
    expect(h.calls.at(-1)?.route).toBe('DELETE /installation/token');
    // Best effort: a host that refuses the revocation changes nothing for the caller.
    const failing = harness({}, (call) =>
      call.route === 'DELETE /installation/token'
        ? httpError(500, INSTALL_TOKEN)
        : call.route === 'GET /app'
          ? { data: { id: 222, slug: 'auto-swe-approver' } }
          : call.route.startsWith('POST')
            ? { data: { token: INSTALL_TOKEN } }
            : { data: INSTALLATION }
    );
    const got = await getApproverClient(repo, failing.deps);
    if (!got.ok) {
      throw new Error('expected a client');
    }
    await expect(got.client.release()).resolves.toBeUndefined();
  });

  it('succeeds with a repository-scoped, pull_requests:write token', async () => {
    const h = harness();
    const result = await getApproverClient(repo, h.deps);
    expect(result.ok).toBe(true);
    expect(h.calls.map((c) => c.route)).toEqual([
      'GET /app',
      'GET /repos/{owner}/{repo}/installation',
      'POST /app/installations/{installation_id}/access_tokens',
    ]);
    expect(h.calls[1]?.params).toMatchObject({ owner: 'acme', repo: 'payments' });
    expect(h.calls[2]?.params).toMatchObject({
      installation_id: 777,
      permissions: { pull_requests: 'write' },
      repositories: ['payments'],
    });
    const body = h.calls[2]?.params as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['installation_id', 'permissions', 'repositories']);
    // First Octokit is authenticated with the JWT, second with the installation token.
    expect(h.created).toHaveLength(2);
    expect(h.created[1]?.auth).toBe(INSTALL_TOKEN);
  });

  it('mints a well-formed RS256 App JWT', async () => {
    const h = harness();
    await getApproverClient(repo, h.deps);
    const jwt = h.created[0]?.auth as string;
    const { header, payload, valid } = decodeJwt(jwt);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const now = Math.floor(new Date('2026-10-29T12:00:00Z').getTime() / 1000);
    expect(payload.iss).toBe('222');
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(9 * 60 + 60);
    expect(payload.exp - now).toBeLessThanOrEqual(9 * 60);
  });

  it('uses the repository API URL, else a non-default instance URL', async () => {
    const h = harness({
      loadGitHubConfig: async () => ({
        ...instance,
        apiUrl: 'https://ghe.example.com/api/v3',
        baseUrl: 'https://ghe.example.com',
      }),
    });
    await getApproverClient(repo, h.deps);
    expect(h.created[0]?.baseUrl).toBe('https://ghe.example.com/api/v3');
    const h2 = harness();
    await getApproverClient(repo, h2.deps);
    expect(h2.created[0]?.baseUrl).toBeUndefined();
  });

  it('refuses an unusable private key without leaking it', async () => {
    const h = harness({
      loadApproverConfig: async () => ({
        ...approverConfig,
        privateKey: 'not a pem SECRETKEYTEXT',
      }),
    });
    const result = await getApproverClient(repo, h.deps);
    expect(result).toEqual({ ok: false, reason: 'key-invalid' });
    expect(JSON.stringify(result)).not.toContain('SECRETKEYTEXT');
  });

  it('propagates other errors with no credential in them', async () => {
    const h = harness({}, (call) =>
      call.route === 'GET /app'
        ? { data: { id: 222, slug: 'auto-swe-approver' } }
        : call.route.startsWith('GET /repos/')
          ? httpError(500, 'boom')
          : { data: {} }
    );
    const err = await getApproverClient(repo, h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = String((err as Error).stack) + (err as Error).message;
    expect(text).not.toContain(PRIVATE_KEY.slice(30, 80));
    expect(text).not.toContain(INSTALL_TOKEN);
  });

  it('never leaks the key, JWT or token in anything it returns, and never calls a merge route', async () => {
    const h = harness();
    const result = await getApproverClient(repo, h.deps);
    const seen = JSON.stringify([result.ok ? { ok: true } : result, h.calls]);
    expect(seen).not.toContain(PRIVATE_KEY.slice(30, 80));
    expect(seen).not.toContain(INSTALL_TOKEN);
    expect(seen).not.toContain(h.created[0]?.auth as string);
    expect(h.calls.every((c) => !/merge/i.test(c.route))).toBe(true);
  });
});

function client(handler: (call: Call) => unknown): { client: ApproverClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: async (route: string, params: Record<string, unknown> = {}) => {
        calls.push({ params, route });
        const out = handler({ params, route });
        if (out instanceof Error) {
          throw out;
        }
        return out as { data: unknown };
      },
    },
  };
}

describe('submitApprovingReview', () => {
  it('posts an APPROVE bound to the head commit', async () => {
    const c = client(() => ({ data: { id: 4242 } }));
    const out = await submitApprovingReview(c.client, repo, 9, {
      body: 'Approved by policy.',
      headSha: 'abc123',
    });
    expect(out).toEqual({ ok: true, reviewId: '4242' });
    expect(c.calls).toEqual([
      {
        params: {
          body: 'Approved by policy.',
          commit_id: 'abc123',
          event: 'APPROVE',
          owner: 'acme',
          pull_number: 9,
          repo: 'payments',
        },
        route: 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      },
    ]);
  });

  it('truncates the body to 1000 characters', async () => {
    const c = client(() => ({ data: { id: 1 } }));
    await submitApprovingReview(c.client, repo, 9, { body: 'x'.repeat(5000), headSha: 'abc' });
    expect(String(c.calls[0]?.params.body)).toHaveLength(1000);
  });

  it.each([403, 404, 422])('maps %i to a fixed reason, not the host message', async (status) => {
    const c = client(() => httpError(status, 'LEAKY host message'));
    const out = await submitApprovingReview(c.client, repo, 9, { body: 'b', headSha: 'abc' });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('LEAKY');
    expect(out).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('lets other errors propagate', async () => {
    const c = client(() => httpError(500));
    await expect(
      submitApprovingReview(c.client, repo, 9, { body: 'b', headSha: 'abc' })
    ).rejects.toThrow();
  });

  it('refuses a missing head sha without calling the host', async () => {
    const c = client(() => ({ data: { id: 1 } }));
    const out = await submitApprovingReview(c.client, repo, 9, { body: 'b', headSha: ' ' });
    expect(out.ok).toBe(false);
    expect(c.calls).toHaveLength(0);
  });
});

describe('ownApprovals', () => {
  const bot = 'auto-swe-approver[bot]';
  const r = (login: string, state: string, commitId: string, id = login + state + commitId) => ({
    commitId,
    id,
    login,
    state,
    submittedAt: null,
  });

  it('returns every standing approval of the login, whatever commit it names', () => {
    const a = r(bot, 'APPROVED', 'old');
    const b = r('Auto-SWE-Approver[BOT]', 'APPROVED', 'h1');
    expect(
      ownApprovals([a, r('alice', 'APPROVED', 'h1'), b, r(bot, 'DISMISSED', 'h0')], bot)
    ).toEqual([a, b]);
  });

  it('returns nothing for another login or no approval', () => {
    expect(ownApprovals([r('other[bot]', 'APPROVED', 'h1')], bot)).toEqual([]);
    expect(ownApprovals([], bot)).toEqual([]);
  });
});

describe('findOwnApproval', () => {
  const bot = 'auto-swe-approver[bot]';
  const r = (login: string, state: string, commitId: string, id = login + state) => ({
    commitId,
    login,
    reviewId: id,
    state,
    submittedAt: null,
  });

  it('finds the approval at the head', () => {
    const a = r(bot, 'APPROVED', 'h1');
    expect(findOwnApproval([r('alice', 'APPROVED', 'h1'), a], bot, 'h1')).toBe(a);
  });

  it('matches the login case-insensitively', () => {
    const a = r('Auto-SWE-Approver[BOT]', 'APPROVED', 'h1');
    expect(findOwnApproval([a], bot, 'h1')).toBe(a);
  });

  it('ignores an approval of a stale commit', () => {
    expect(findOwnApproval([r(bot, 'APPROVED', 'old')], bot, 'h1')).toBeNull();
  });

  it.each(['DISMISSED', 'CHANGES_REQUESTED', 'COMMENTED'])(
    'is superseded by a later %s review',
    (state) => {
      expect(
        findOwnApproval([r(bot, 'APPROVED', 'h1'), r(bot, state, 'h1')], bot, 'h1')
      ).toBeNull();
    }
  );

  it('is not affected by another bot or person', () => {
    expect(
      findOwnApproval([r('other[bot]', 'APPROVED', 'h1'), r('alice', 'APPROVED', 'h1')], bot, 'h1')
    ).toBeNull();
  });

  it('returns the latest of repeated approvals', () => {
    const second = r(bot, 'APPROVED', 'h1', 'second');
    expect(findOwnApproval([r(bot, 'APPROVED', 'h1', 'first'), second], bot, 'h1')).toBe(second);
  });

  it('returns null for no reviews or a blank head', () => {
    expect(findOwnApproval([], bot, 'h1')).toBeNull();
    expect(findOwnApproval([r(bot, 'APPROVED', '')], bot, '')).toBeNull();
  });
});
