import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetMetricsForTests } from './metrics.js';
import { observeSignInResult, observeSignOut, recordSignInAudit } from './signInAudit.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function db(userId: string | null = 'u-1') {
  return {
    configAuditLog: { create: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => (userId ? { id: userId } : null)) },
    userActivityEvent: { create: vi.fn(async () => ({})) },
  };
}

const headers = () => new Headers({ 'user-agent': CHROME });
const failed = (code: string, status = 401) => ({
  body: { code },
  name: 'APIError',
  statusCode: status,
});

class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

describe('recordSignInAudit', () => {
  it('stores the method on the audit row and writes a sign_in event with coarse props', async () => {
    const d = db();
    await recordSignInAudit(
      d as never,
      { id: 's-1', ipAddress: '203.0.113.9', userId: 'u-1' },
      { headers: headers(), params: { id: 'github' }, path: '/callback/:id' }
    );
    expect(d.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ afterJson: { event: 'sign_in', method: 'github' } }),
    });
    await vi.waitFor(() => expect(d.userActivityEvent.create).toHaveBeenCalled());
    const data = (d.userActivityEvent.create.mock.calls[0] as unknown as [{ data: unknown }])[0]
      .data;
    expect(data).toMatchObject({
      actorId: 'u-1',
      ip: '203.0.113.0',
      kind: 'sign_in',
      props: { browser: 'Chrome', method: 'github', os: 'Windows' },
      route: 'auth:github',
    });
    expect(JSON.stringify(data)).not.toContain('Mozilla');
  });

  it('never throws when the activity write fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = db();
    d.userActivityEvent.create.mockRejectedValue(new Error('down'));
    await expect(
      recordSignInAudit(d as never, { id: 's', userId: 'u' }, { path: '/sign-in/email' })
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });
});

describe('observeSignInResult', () => {
  let reader: Reader;
  beforeEach(() => {
    reader = new Reader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    _resetMetricsForTests();
  });
  afterEach(() => {
    metrics.disable();
    _resetMetricsForTests();
  });

  async function failedCount(method: string): Promise<number> {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'auth.sign_in.failed');
    const point = metric?.dataPoints.find((p) => p.attributes.method === method);
    return Number(point?.value ?? 0);
  }

  it('records a failure for a known user without storing the email', async () => {
    const d = db('u-9');
    await observeSignInResult(d as never, {
      body: { email: 'Someone@Example.com', password: 'hunter2' },
      context: { returned: failed('INVALID_EMAIL_OR_PASSWORD') },
      headers: headers(),
      path: '/sign-in/email',
    });
    expect(d.user.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { email: 'someone@example.com' },
    });
    await vi.waitFor(() => expect(d.userActivityEvent.create).toHaveBeenCalled());
    const { data } = (d.userActivityEvent.create.mock.calls[0] as unknown as [{ data: object }])[0];
    expect(data).toMatchObject({
      actorId: 'u-9',
      kind: 'sign_in_failed',
      props: {
        browser: 'Chrome',
        method: 'password',
        os: 'Windows',
        reason: 'invalid_credentials',
      },
    });
    expect(JSON.stringify(data)).not.toMatch(/example\.com|hunter2/);
    expect(await failedCount('password')).toBe(1);
  });

  it('counts but writes no row for an unknown email', async () => {
    const d = db(null);
    await observeSignInResult(d as never, {
      body: { email: 'nobody@example.com' },
      context: { returned: failed('INVALID_EMAIL_OR_PASSWORD') },
      path: '/sign-in/email',
    });
    expect(d.userActivityEvent.create).not.toHaveBeenCalled();
    expect(await failedCount('password')).toBe(1);
  });

  it('counts an OAuth failure with no actor', async () => {
    const d = db();
    await observeSignInResult(d as never, {
      context: {
        returned: {
          headers: new Headers({ location: '/login?error=access_denied' }),
          name: 'APIError',
          statusCode: 302,
        },
      },
      params: { id: 'github' },
      path: '/callback/:id',
    });
    expect(d.userActivityEvent.create).not.toHaveBeenCalled();
    expect(await failedCount('github')).toBe(1);
  });

  it('ignores a success, a sign-up and unrelated paths', async () => {
    const d = db();
    await observeSignInResult(d as never, {
      body: { email: 'a@b.c' },
      context: { returned: { user: {} } },
      path: '/sign-in/email',
    });
    await observeSignInResult(d as never, {
      body: { email: 'a@b.c' },
      context: { returned: failed('USER_ALREADY_EXISTS', 422) },
      path: '/sign-up/email',
    });
    await observeSignInResult(d as never, {
      context: { returned: failed('X', 500) },
      path: '/get-session',
    });
    expect(d.user.findUnique).not.toHaveBeenCalled();
    expect(d.userActivityEvent.create).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = db();
    d.user.findUnique.mockRejectedValue(new Error('down'));
    await expect(
      observeSignInResult(d as never, {
        body: { email: 'a@b.c' },
        context: { returned: failed('INVALID_EMAIL_OR_PASSWORD') },
        path: '/sign-in/email',
      })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('observeSignOut', () => {
  const ctx = (token: string | null, userId = 'u-2') => ({
    context: {
      authCookies: { sessionToken: { name: 'session' } },
      internalAdapter: { findSession: vi.fn(async () => ({ session: { userId } })) },
      secret: 's3cret',
    },
    getSignedCookie: vi.fn(async () => token),
    headers: headers(),
    path: '/sign-out',
  });

  it('records a sign_out for the session being ended', async () => {
    const d = db();
    await observeSignOut(d as never, ctx('tok'));
    await vi.waitFor(() => expect(d.userActivityEvent.create).toHaveBeenCalled());
    expect(
      (d.userActivityEvent.create.mock.calls[0] as unknown as [{ data: object }])[0].data
    ).toMatchObject({
      actorId: 'u-2',
      kind: 'sign_out',
      props: { browser: 'Chrome', os: 'Windows' },
      route: 'auth:sign_out',
    });
  });

  it('records nothing without a session cookie, and ignores other paths', async () => {
    const d = db();
    await observeSignOut(d as never, ctx(null));
    await observeSignOut(d as never, { ...ctx('tok'), path: '/sign-in/email' });
    expect(d.userActivityEvent.create).not.toHaveBeenCalled();
  });
});
