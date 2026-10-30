import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: () => '',
  encryptSecret: (s: string) => ({
    authTag: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
    keyVersion: 1,
    lastFour: s.trimEnd().slice(-4),
    nonce: new Uint8Array([3]),
  }),
}));

const resolveGitHubConfig = vi.fn();
const resolveApprover = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubApproverAppConfig: () => resolveApprover(),
  resolveGitHubConfig: () => resolveGitHubConfig(),
}));
const sweep = vi.fn();
vi.mock('../lib/prEvaluationSweep.js', () => ({
  GLOBAL_SWEEP_CAP: 500,
  sweepArmedPullRequests: (...args: unknown[]) => sweep(...args),
}));
const fetchIdentity = vi.fn();
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({
  fetchGitHubAppIdentity: (input: unknown) => fetchIdentity(input),
}));

const { githubApproverAppRoutes } = await import('./githubApproverApp.js');

const AUTH = { authorization: 'Bearer fake-jwt' };
const URL = '/api/v1/integrations/github-approver-app';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

function row(over: Record<string, unknown> = {}) {
  return {
    appId: '42',
    appSlug: 'approver-bot',
    id: 'default',
    privateKeyAuthTag: new Uint8Array([1]),
    privateKeyCiphertext: new Uint8Array([2]),
    privateKeyKeyVersion: 1,
    privateKeyLastFour: 'zzzz',
    privateKeyNonce: new Uint8Array([3]),
    retiredAppSlugs: [] as string[],
    updatedAt: new Date('2026-10-29'),
    updatedById: null,
    ...over,
  };
}

async function buildApp(role: string) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    gitHubApproverApp: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(githubApproverAppRoutes, { prefix: '/api/v1/integrations' });
  await app.ready();
  return { app, prisma };
}

describe('githubApproverAppRoutes', () => {
  let admin: Awaited<ReturnType<typeof buildApp>>;
  let engineer: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    admin = await buildApp('ADMIN');
    engineer = await buildApp('ENGINEER');
  });
  afterAll(async () => {
    await admin.app.close();
    await engineer.app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveGitHubConfig.mockResolvedValue({ apiUrl: 'https://api.github.com', appId: '1000' });
    resolveApprover.mockResolvedValue(null);
    sweep.mockResolvedValue({ failed: 0, found: 0, started: 0, truncated: false });
    fetchIdentity.mockResolvedValue({ id: '42', ok: true, slug: 'approver-bot' });
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(null);
    admin.prisma.gitHubApproverApp.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => row(args.create)
    );
  });

  const put = (payload: object) =>
    admin.app.inject({ headers: AUTH, method: 'PUT', payload, url: URL });

  it('refuses every operation to a non-ADMIN', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await engineer.app.inject({
        headers: AUTH,
        method,
        payload: method === 'PUT' ? { appId: '5' } : undefined,
        url: URL,
      });
      expect(res.statusCode).toBe(403);
    }
    expect(engineer.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
  });

  it('GET reports unconfigured when there is no row', async () => {
    const res = await admin.app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      appId: null,
      appSlug: null,
      configured: false,
      privateKeyLastFour: null,
      updatedAt: null,
    });
  });

  it('GET returns the id, slug and key last four, and never the key or its envelope', async () => {
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
    const res = await admin.app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(JSON.parse(res.payload)).toEqual({
      appId: '42',
      appSlug: 'approver-bot',
      configured: true,
      privateKeyLastFour: 'zzzz',
      updatedAt: '2026-10-29T00:00:00.000Z',
    });
    expect(res.payload).not.toMatch(/ciphertext|nonce|authTag|PRIVATE KEY/i);
  });

  it('GET is not configured when the key is missing', async () => {
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
      row({ privateKeyCiphertext: null, privateKeyLastFour: null })
    );
    const res = await admin.app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(JSON.parse(res.payload)).toMatchObject({ configured: false, privateKeyLastFour: null });
  });

  it('PUT seals the key, never echoes it, and audits field names only', async () => {
    const res = await put({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
    expect(res.statusCode).toBe(200);
    const args = admin.prisma.gitHubApproverApp.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({
      appId: '42',
      appSlug: 'approver-bot',
      privateKeyCiphertext: new Uint8Array([2]),
      updatedById: 'user-1',
    });
    expect(res.payload).not.toContain('PRIVATE KEY');
    const audit = JSON.stringify(admin.prisma.configAuditLog.create.mock.calls);
    expect(admin.prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    expect(audit).toContain('GitHubApproverApp');
    expect(audit).toContain('privateKey');
    expect(audit).not.toContain('PRIVATE KEY');
    expect(audit).not.toContain('approver-bot');
    const data = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
    expect(data.afterJson).toEqual({ changedFields: ['appId', 'appSlug', 'privateKey'] });
  });

  it('PUT saves a subset and leaves the stored key when the key is blank', async () => {
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
    const res = await put({ appSlug: 'renamed', privateKey: '' });
    expect(res.statusCode).toBe(200);
    const args = admin.prisma.gitHubApproverApp.upsert.mock.calls[0][0];
    expect(args.update).toEqual({
      appSlug: 'renamed',
      retiredAppSlugs: ['approver-bot'],
      updatedById: 'user-1',
    });
    expect(args.update).not.toHaveProperty('privateKeyCiphertext');
    expect(admin.prisma.configAuditLog.create.mock.calls[0][0].data.afterJson).toEqual({
      changedFields: ['appSlug'],
    });
  });

  it('PUT with nothing to change writes and audits nothing', async () => {
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
    const res = await put({ privateKey: '' });
    expect(res.statusCode).toBe(200);
    expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
    expect(admin.prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('PUT refuses a key that is not an RSA PEM, naming the field', async () => {
    for (const privateKey of ['not a pem', EC_PEM]) {
      const res = await put({ privateKey });
      expect(res.statusCode).toBe(400);
      const error = JSON.parse(res.payload).error;
      expect(error.code).toBe('INVALID_PRIVATE_KEY');
      expect(error.details).toEqual({ field: 'privateKey' });
      expect(res.payload).not.toContain('not a pem');
    }
    expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
  });

  it('PUT refuses a non-numeric app id and a badly formed slug', async () => {
    const badId = await put({ appId: 'abc' });
    expect(badId.statusCode).toBe(400);
    expect(JSON.parse(badId.payload).error).toMatchObject({
      code: 'INVALID_APP_ID',
      details: { field: 'appId' },
    });
    for (const appSlug of ['Has-Upper', 'has space', 'under_score', '']) {
      const res = await put({ appSlug });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toMatchObject({
        code: 'INVALID_APP_SLUG',
        details: { field: 'appSlug' },
      });
    }
    expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
  });

  it('PUT refuses an app id equal to the main GitHub App', async () => {
    resolveGitHubConfig.mockResolvedValue({ appId: '42' });
    const res = await put({ appId: '42' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('APPROVER_APP_IS_MAIN_APP');
    expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
  });

  it('PUT refuses a change that would leave the stored id equal to the main App', async () => {
    resolveGitHubConfig.mockResolvedValue({ appId: '42' });
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
    const res = await put({ appSlug: 'other' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('APPROVER_APP_IS_MAIN_APP');
  });

  it('PUT accepts any id when the main App has none', async () => {
    resolveGitHubConfig.mockResolvedValue({ appId: null });
    const res = await put({ appId: '42' });
    expect(res.statusCode).toBe(200);
  });

  describe('the App is verified with GitHub before it is saved', () => {
    it('asks GET /app with the supplied id and key, against the instance API host', async () => {
      resolveGitHubConfig.mockResolvedValue({
        apiUrl: 'https://ghe.example.com/api/v3',
        appId: null,
      });
      const res = await put({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      expect(res.statusCode).toBe(200);
      expect(fetchIdentity).toHaveBeenCalledWith({
        apiUrl: 'https://ghe.example.com/api/v3',
        appId: '42',
        privateKey: PEM,
      });
    });

    it('uses the stored key when only the slug changes, and compares the slug case-insensitively', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      resolveApprover.mockResolvedValue({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      fetchIdentity.mockResolvedValue({ id: '42', ok: true, slug: 'Renamed' });
      const res = await put({ appSlug: 'renamed' });
      expect(res.statusCode).toBe(200);
      expect(fetchIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ appId: '42', privateKey: PEM })
      );
    });

    it.each([
      ['GitHub rejects the key', { ok: false, reason: 'rejected' }],
      ['GitHub names another App id', { id: '99', ok: true, slug: 'approver-bot' }],
      ['GitHub names another slug', { id: '42', ok: true, slug: 'someone-elses-app' }],
    ])('refuses with APPROVER_APP_UNVERIFIED and saves nothing when %s', async (_n, answer) => {
      fetchIdentity.mockResolvedValue(answer);
      const res = await put({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('APPROVER_APP_UNVERIFIED');
      expect(res.payload).not.toContain('someone-elses-app');
      expect(res.payload).not.toContain('PRIVATE KEY');
      expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
      expect(admin.prisma.configAuditLog.create).not.toHaveBeenCalled();
    });

    it('refuses with a 502 and saves nothing when GitHub cannot be reached', async () => {
      fetchIdentity.mockResolvedValue({ ok: false, reason: 'unreachable' });
      const res = await put({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.payload).error.code).toBe('APPROVER_APP_UNREACHABLE');
      expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
    });

    it('does not ask GitHub while the identity is still incomplete', async () => {
      const res = await put({ appId: '42' });
      expect(res.statusCode).toBe(200);
      expect(fetchIdentity).not.toHaveBeenCalled();
    });
  });

  it('DELETE clears the identity and audits the cleared field names', async () => {
    admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
    admin.prisma.gitHubApproverApp.upsert.mockResolvedValue(
      row({
        appId: null,
        appSlug: null,
        privateKeyAuthTag: null,
        privateKeyCiphertext: null,
        privateKeyKeyVersion: null,
        privateKeyLastFour: null,
        privateKeyNonce: null,
      })
    );
    const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
    expect(res.statusCode).toBe(204);
    const args = admin.prisma.gitHubApproverApp.upsert.mock.calls[0][0];
    expect(args.update).toMatchObject({
      appId: null,
      appSlug: null,
      privateKeyCiphertext: null,
      privateKeyLastFour: null,
    });
    const audit = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('DELETE');
    expect(audit.beforeJson).toEqual({ changedFields: ['appId', 'appSlug', 'privateKey'] });
    expect(JSON.stringify(audit)).not.toContain('approver-bot');
  });

  describe('retired slugs keep an old App recognisable for withdrawal', () => {
    const saved = () => admin.prisma.gitHubApproverApp.upsert.mock.calls[0][0].update;

    it('DELETE keeps the removed slug, lower-case, before the sweep runs', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row({ appSlug: 'Approver-Bot' }));
      const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(res.statusCode).toBe(204);
      expect(saved()).toMatchObject({ appSlug: null, retiredAppSlugs: ['approver-bot'] });
      expect(sweep.mock.invocationCallOrder[0]).toBeGreaterThan(
        admin.prisma.gitHubApproverApp.upsert.mock.invocationCallOrder[0]
      );
    });

    it('DELETE of a row with no slug adds nothing', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
        row({ appSlug: null, retiredAppSlugs: ['older'] })
      );
      await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(saved().retiredAppSlugs).toEqual(['older']);
    });

    it('a PUT that changes the slug retires the old one', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      resolveApprover.mockResolvedValue({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      fetchIdentity.mockResolvedValue({ id: '42', ok: true, slug: 'renamed' });
      expect((await put({ appSlug: 'renamed' })).statusCode).toBe(200);
      expect(saved().retiredAppSlugs).toEqual(['approver-bot']);
    });

    it('a PUT that changes the app id retires the old slug, and one that does not touch either keeps the list', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
        row({ retiredAppSlugs: ['older'] })
      );
      resolveApprover.mockResolvedValue({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      fetchIdentity.mockResolvedValue({ id: '43', ok: true, slug: 'new-one' });
      expect((await put({ appId: '43', appSlug: 'new-one' })).statusCode).toBe(200);
      expect(saved().retiredAppSlugs).toEqual(['older', 'approver-bot']);
      fetchIdentity.mockResolvedValue({ id: '42', ok: true, slug: 'approver-bot' });
      admin.prisma.gitHubApproverApp.upsert.mockClear();
      await put({ privateKey: PEM });
      expect(admin.prisma.gitHubApproverApp.upsert.mock.calls[0][0].update).not.toHaveProperty(
        'retiredAppSlugs'
      );
    });

    it('saving a retired slug again as the active one removes it from the list', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
        row({ appSlug: 'current', retiredAppSlugs: ['first', 'approver-bot', 'third'] })
      );
      resolveApprover.mockResolvedValue({ appId: '42', appSlug: 'current', privateKey: PEM });
      fetchIdentity.mockResolvedValue({ id: '42', ok: true, slug: 'approver-bot' });
      expect((await put({ appSlug: 'approver-bot' })).statusCode).toBe(200);
      expect(saved().retiredAppSlugs).toEqual(['first', 'third', 'current']);
    });

    it('does not list a slug twice', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
        row({ retiredAppSlugs: ['approver-bot', 'x'] })
      );
      await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(saved().retiredAppSlugs).toEqual(['x', 'approver-bot']);
    });

    it('keeps at most five, dropping the oldest', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(
        row({ retiredAppSlugs: ['a1', 'a2', 'a3', 'a4', 'a5'] })
      );
      await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(saved().retiredAppSlugs).toEqual(['a2', 'a3', 'a4', 'a5', 'approver-bot']);
    });

    it('never puts a slug in an audit entry or a response', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      const audit = JSON.stringify(admin.prisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain('approver-bot');
      const get = await admin.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(get.payload).not.toContain('retired');
    });
  });

  it('DELETE with nothing stored is a no-op that audits nothing', async () => {
    const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
    expect(res.statusCode).toBe(204);
    expect(admin.prisma.gitHubApproverApp.upsert).not.toHaveBeenCalled();
    expect(admin.prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  describe('the deployment-wide re-evaluation after the credentials change', () => {
    const SWEPT = { failed: 0, found: 7, started: 7, truncated: false };
    const sweptAfter = (mock: { mock: { invocationCallOrder: number[] } }) =>
      sweep.mock.invocationCallOrder[0] > mock.mock.invocationCallOrder[0];

    it('DELETE starts the sweep after the row is cleared, with the kill switch selection, and audits a count', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      sweep.mockResolvedValue(SWEPT);
      const res = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(res.statusCode).toBe(204);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep.mock.calls[0]?.[2]).toEqual({ cap: 500 });
      expect(sweptAfter(admin.prisma.gitHubApproverApp.upsert)).toBe(true);
      const audit = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
      expect(audit.afterJson).toEqual({ prEvaluationSweep: { pullRequests: 7 } });
    });

    it.each([
      ['the key', { privateKey: PEM }],
      ['the slug', { appSlug: 'renamed' }],
      ['the app id', { appId: '43' }],
    ])('PUT starts the sweep after saving when %s changes', async (_n, payload) => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      resolveApprover.mockResolvedValue({ appId: '42', appSlug: 'approver-bot', privateKey: PEM });
      fetchIdentity.mockResolvedValue({
        id: 'appId' in payload ? '43' : '42',
        ok: true,
        slug: 'appSlug' in payload ? 'renamed' : 'approver-bot',
      });
      sweep.mockResolvedValue(SWEPT);
      const res = await put(payload);
      expect(res.statusCode).toBe(200);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep.mock.calls[0]?.[2]).toEqual({ cap: 500 });
      expect(sweptAfter(admin.prisma.gitHubApproverApp.upsert)).toBe(true);
      const data = admin.prisma.configAuditLog.create.mock.calls[0][0].data;
      expect(data.afterJson.prEvaluationSweep).toEqual({ pullRequests: 7 });
    });

    it('does not sweep when the request changes nothing, is refused, or restates the stored value', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      await put({ privateKey: '' });
      await put({ appSlug: 'approver-bot' });
      fetchIdentity.mockResolvedValue({ ok: false, reason: 'rejected' });
      await put({ privateKey: PEM });
      await put({ appId: 'abc' });
      expect(sweep).not.toHaveBeenCalled();
    });

    it('does not sweep when nothing is stored to delete', async () => {
      await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(sweep).not.toHaveBeenCalled();
    });

    it('a sweep that cannot start does not fail the request and leaks nothing', async () => {
      admin.prisma.gitHubApproverApp.findUnique.mockResolvedValue(row());
      sweep.mockRejectedValue(new Error('boom approver-bot PRIVATE KEY'));
      const del = await admin.app.inject({ headers: AUTH, method: 'DELETE', url: URL });
      expect(del.statusCode).toBe(204);
      const res = await put({ privateKey: PEM });
      expect(res.statusCode).toBe(200);
      expect(res.payload).not.toContain('boom');
      expect(admin.prisma.configAuditLog.create).toHaveBeenCalledTimes(2);
      const audit = JSON.stringify(admin.prisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain('boom');
      expect(audit).not.toContain('PRIVATE KEY');
    });
  });
});
