import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests } from './crypto.js';
import {
  buildCallbackPayload,
  CallbackRequestSchema,
  callbackRetryDelayMs,
  callbackTargetOrigin,
  callbackUrlMatchesEndpoint,
  endpointSigningSecrets,
  newEndpointSecretColumns,
  nextCallbackAttemptAt,
  normaliseCallbackOrigin,
  normaliseCallbackPathPrefix,
  openCallbackUrl,
  parseCallbackUrl,
  rotatedEndpointSecretColumns,
  sealCallbackUrl,
} from './runCallbacks.js';

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  _resetKeyCacheForTests();
});

function matches(url: string, endpoint: { origin: string; pathPrefix: string }): boolean {
  const parsed = parseCallbackUrl(url);
  return parsed.ok && callbackUrlMatchesEndpoint(parsed.value, endpoint);
}

describe('normaliseCallbackOrigin', () => {
  it('stores the URL standard origin: lowercase host, default port elided', () => {
    expect(normaliseCallbackOrigin('https://Hooks.Example.com:443', false)).toEqual({
      ok: true,
      origin: 'https://hooks.example.com',
    });
    expect(normaliseCallbackOrigin('https://hooks.example.com:8443/', false)).toEqual({
      ok: true,
      origin: 'https://hooks.example.com:8443',
    });
  });

  it('requires https unless the endpoint opts in to a private network', () => {
    expect(normaliseCallbackOrigin('http://hooks.example.com', false).ok).toBe(false);
    expect(normaliseCallbackOrigin('http://10.0.0.5:8080', true)).toEqual({
      ok: true,
      origin: 'http://10.0.0.5:8080',
    });
  });

  it('refuses a path, query, fragment or credentials in the origin', () => {
    for (const bad of [
      'https://hooks.example.com/path',
      'https://hooks.example.com/?q=1',
      'https://hooks.example.com/#x',
      'https://user:pw@hooks.example.com',
      'https://@hooks.example.com',
    ]) {
      expect(normaliseCallbackOrigin(bad, false), bad).toMatchObject({ ok: false });
    }
  });

  it('answers BASE_URL_REFUSED for a private host without the opt-in, and loopback always', () => {
    expect(normaliseCallbackOrigin('https://10.0.0.5', false)).toMatchObject({
      code: 'BASE_URL_REFUSED',
      ok: false,
    });
    expect(normaliseCallbackOrigin('https://127.0.0.1', true)).toMatchObject({
      code: 'BASE_URL_REFUSED',
      ok: false,
    });
    expect(normaliseCallbackOrigin('https://169.254.169.254', true)).toMatchObject({
      code: 'BASE_URL_REFUSED',
      ok: false,
    });
  });
});

describe('normaliseCallbackPathPrefix', () => {
  it('defaults to / and accepts a canonical absolute path', () => {
    expect(normaliseCallbackPathPrefix(undefined)).toEqual({ ok: true, pathPrefix: '/' });
    expect(normaliseCallbackPathPrefix('/hooks/auto-swe')).toEqual({
      ok: true,
      pathPrefix: '/hooks/auto-swe',
    });
  });

  it('refuses dot segments, encoded separators, a query and a relative path', () => {
    for (const bad of [
      'hooks',
      '/hooks/../admin',
      '/hooks/%2e%2e/x',
      '/a%2Fb',
      '/a?b',
      '/a\\b',
      '/hooks/..;/admin',
      '/hooks;x',
      '/hooks/%252e%252e/admin',
      '/hooks/.%00./x',
      '/hooks/%7F',
      '/hooks/%3b/x',
      '/hooks/%c0%ae%c0%ae/admin',
      '/hooks/%C1%9C',
      '/hooks/%e0%80%ae',
      '/hooks/%u002e%u002e/admin',
    ]) {
      expect(normaliseCallbackPathPrefix(bad).ok, bad).toBe(false);
    }
  });
});

describe('callback URL matching', () => {
  const ep = { origin: 'https://hooks.example.com', pathPrefix: '/hooks' };

  it('accepts the prefix itself, a path under it and a query', () => {
    expect(matches('https://hooks.example.com/hooks', ep)).toBe(true);
    expect(matches('https://hooks.example.com/hooks/run?token=abc&x=1', ep)).toBe(true);
    expect(matches('https://HOOKS.example.com:443/hooks/a', ep)).toBe(true);
  });

  it('matches the prefix on a segment boundary only', () => {
    expect(matches('https://hooks.example.com/hooksevil', ep)).toBe(false);
    expect(matches('https://hooks.example.com/admin', ep)).toBe(false);
  });

  it('cannot escape the prefix with dot segments, plain or encoded', () => {
    expect(matches('https://hooks.example.com/hooks/../admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%2e%2e/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%2E%2E/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/.%2e/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks%2F..%2Fadmin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks\\..\\admin', ep)).toBe(false);
    // A path parameter, a double encoding, an encoded control character.
    expect(matches('https://hooks.example.com/hooks/..;/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%252e%252e/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/.%00./x', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%0a', ep)).toBe(false);
    // Overlong UTF-8, IIS %u, an encoded `;`.
    expect(matches('https://hooks.example.com/hooks/%c0%ae%c0%ae/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%e0%80%ae', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/%u002e%u002e/admin', ep)).toBe(false);
    expect(matches('https://hooks.example.com/hooks/..%3b/admin', ep)).toBe(false);
    // Ordinary percent-encoding is still accepted.
    expect(matches('https://hooks.example.com/hooks/caf%C3%A9', ep)).toBe(true);
  });

  it('refuses userinfo and a fragment', () => {
    expect(parseCallbackUrl('https://u:p@hooks.example.com/hooks').ok).toBe(false);
    expect(parseCallbackUrl('https://hooks.example.com@evil.example/hooks').ok).toBe(false);
    expect(parseCallbackUrl('https://hooks.example.com/hooks#frag').ok).toBe(false);
  });

  it('requires the exact origin: scheme and port included', () => {
    expect(matches('https://hooks.example.com:8443/hooks', ep)).toBe(false);
    expect(matches('http://hooks.example.com/hooks', ep)).toBe(false);
    expect(matches('https://evil.example.com/hooks', ep)).toBe(false);
  });

  it('shows origin and path as the target, never the query', () => {
    const parsed = parseCallbackUrl('https://hooks.example.com/hooks/a?token=secret');
    expect(parsed.ok && parsed.value.target).toBe('https://hooks.example.com/hooks/a');
  });

  it('treats a prefix with a trailing slash as a directory', () => {
    const dir = { origin: ep.origin, pathPrefix: '/hooks/' };
    expect(matches('https://hooks.example.com/hooks/x', dir)).toBe(true);
    expect(matches('https://hooks.example.com/hooks', dir)).toBe(false);
  });
});

describe('CallbackRequestSchema', () => {
  it('needs exactly one of endpointId and url', () => {
    expect(CallbackRequestSchema.safeParse({}).success).toBe(false);
    expect(
      CallbackRequestSchema.safeParse({
        endpointId: '00000000-0000-4000-8000-000000000000',
        url: 'https://x.example/',
      }).success
    ).toBe(false);
    expect(CallbackRequestSchema.safeParse({ url: 'https://x.example/' }).success).toBe(true);
  });

  it('caps context at 1 KB serialised and refuses unknown keys', () => {
    expect(
      CallbackRequestSchema.safeParse({ context: { a: 'x'.repeat(1000) }, url: 'https://x/' })
        .success
    ).toBe(true);
    expect(
      CallbackRequestSchema.safeParse({ context: 'x'.repeat(1100), url: 'https://x/' }).success
    ).toBe(false);
    expect(CallbackRequestSchema.safeParse({ other: 1, url: 'https://x/' }).success).toBe(false);
  });
});

describe('callbackTargetOrigin', () => {
  it('keeps only the origin of a target', () => {
    expect(callbackTargetOrigin('https://hooks.slack.com/services/T0/B0/secret')).toBe(
      'https://hooks.slack.com'
    );
    expect(callbackTargetOrigin(null)).toBeNull();
    expect(callbackTargetOrigin('not a url')).toBeNull();
  });
});

describe('sealed columns', () => {
  it('round-trips a URL and keeps no clear tail of it', () => {
    const sealed = sealCallbackUrl('https://x.example/hooks?token=abcd');
    expect(Object.keys(sealed).sort()).toEqual([
      'urlAuthTag',
      'urlCiphertext',
      'urlKeyVersion',
      'urlNonce',
    ]);
    expect(openCallbackUrl(sealed)).toBe('https://x.example/hooks?token=abcd');
  });

  it('signs with the current secret, and the previous one only inside its overlap', () => {
    const created = newEndpointSecretColumns();
    const existing = {
      ...created.data,
      previousSigningSecretAuthTag: null,
      previousSigningSecretCiphertext: null,
      previousSigningSecretExpiresAt: null,
      previousSigningSecretKeyVersion: null,
      previousSigningSecretLastFour: null,
      previousSigningSecretNonce: null,
    };
    const now = new Date('2026-10-14T00:00:00Z');
    expect(endpointSigningSecrets(existing, now)).toEqual([created.secret]);
    const rotated = rotatedEndpointSecretColumns(existing, now);
    const after = { ...existing, ...rotated.data } as typeof existing;
    expect(endpointSigningSecrets(after, now)).toEqual([rotated.secret, created.secret]);
    expect(endpointSigningSecrets(after, new Date(now.getTime() + 25 * 3600_000))).toEqual([
      rotated.secret,
    ]);
  });
});

describe('payload', () => {
  it('carries the run summary and context, and nothing else', () => {
    const payload = buildCallbackPayload({
      context: { ticket: 'X-1' },
      createdAt: new Date('2026-10-14T00:00:00Z'),
      deliveryId: 'd-1',
      launchedBy: { id: 'sp-1', kind: 'service_principal', templateId: 'tpl-1' },
      run: {
        costUsd: 1.23456789,
        endedAt: new Date('2026-10-14T00:10:00Z'),
        id: 'run-1',
        pullRequestUrl: 'https://github.com/o/r/pull/1',
        startedAt: new Date('2026-10-14T00:00:00Z'),
        status: 'SUCCESS',
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      },
      type: 'run.completed',
      webUrl: 'https://app.example.com/',
    });
    expect(payload).toEqual({
      context: { ticket: 'X-1' },
      createdAt: '2026-10-14T00:00:00.000Z',
      id: 'd-1',
      launchedBy: { id: 'sp-1', kind: 'service_principal', templateId: 'tpl-1' },
      run: {
        costUsd: 1.234568,
        dashboardUrl: 'https://app.example.com/runs/run-1',
        endedAt: '2026-10-14T00:10:00.000Z',
        pullRequestUrl: 'https://github.com/o/r/pull/1',
        startedAt: '2026-10-14T00:00:00.000Z',
        status: 'SUCCESS',
        temporalWorkflowId: 'wf-1',
        workflowRunId: 'run-1',
        workRequestId: 'wr-1',
      },
      type: 'run.completed',
    });
  });
});

describe('retry schedule', () => {
  it('doubles from one minute and caps at six hours', () => {
    expect([1, 2, 3, 4, 9, 10, 20].map(callbackRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      256 * 60_000,
      6 * 3600_000,
      6 * 3600_000,
    ]);
  });

  it('gives up once the next try would fall outside the 24 h window', () => {
    const start = new Date('2026-10-14T00:00:00Z');
    expect(nextCallbackAttemptAt(1, start, start)?.toISOString()).toBe('2026-10-14T00:01:00.000Z');
    const late = new Date(start.getTime() + 20 * 3600_000);
    expect(nextCallbackAttemptAt(12, start, late)).toBeNull();
  });
});
