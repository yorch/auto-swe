import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import {
  newEndpointSecretColumns,
  rotatedEndpointSecretColumns,
  sealCallbackUrl,
} from '@auto-swe/shared/lib/runCallbacks';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/activityLog.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }));

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
    outboundDelivery: {
      findUnique: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma }));

import { logWarn } from '../lib/activityLog.js';
import type { CallbackAttempt, SendCallbackInput } from '../lib/callbackSender.js';
import { attemptDelivery, deliverCallbacks } from './deliverCallbacks.js';

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  _resetKeyCacheForTests();
});

const NOW = new Date('2026-10-14T12:00:00Z');
const URL_WITH_TOKEN = 'https://hooks.example.com/hooks/run?token=receiver-secret';

function endpoint(overrides: Record<string, unknown> = {}) {
  const created = newEndpointSecretColumns();
  return {
    columns: {
      ...created.data,
      allowPrivateNetwork: false,
      disabledAt: null,
      origin: 'https://hooks.example.com',
      pathPrefix: '/hooks',
      previousSigningSecretAuthTag: null,
      previousSigningSecretCiphertext: null,
      previousSigningSecretExpiresAt: null,
      previousSigningSecretKeyVersion: null,
      previousSigningSecretLastFour: null,
      previousSigningSecretNonce: null,
      ...overrides,
    },
    secret: created.secret,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: endpoint().columns,
    event: 'run.completed',
    id: 'd-1',
    payload: { id: 'd-1', run: { status: 'SUCCESS' }, type: 'run.completed' },
    retryWindowStartedAt: NOW,
    runCallback: {
      target: 'https://hooks.example.com/hooks/run',
      ...sealCallbackUrl(URL_WITH_TOKEN),
    },
    status: 'PENDING',
    ...overrides,
  };
}

const sendOk = vi.fn(async (): Promise<CallbackAttempt> => ({ ok: true, statusCode: 200 }));
const send500 = vi.fn(
  async (): Promise<CallbackAttempt> => ({ error: 'HTTP_STATUS', ok: false, statusCode: 500 })
);

function lastUpdate() {
  return (prisma.outboundDelivery.updateMany.mock.calls as unknown[][]).at(-1)?.[0] as {
    data: Record<string, unknown>;
    where: Record<string, unknown>;
  };
}

describe('attemptDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the stored body to the sealed URL and marks the claimed attempt DELIVERED', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(delivery());
    const outcome = await attemptDelivery(
      { attempts: 1, claimToken: 'claim-1', id: 'd-1' },
      { now: () => NOW, send: sendOk }
    );
    expect(outcome).toBe('delivered');
    const input = (sendOk.mock.calls[0] as unknown as [SendCallbackInput])[0];
    expect(input.url).toBe(URL_WITH_TOKEN);
    expect(input.body).toBe(JSON.stringify(delivery().payload));
    expect(input.deliveryId).toBe('d-1');
    expect(input.secrets).toHaveLength(1);
    const update = lastUpdate();
    // Only under this claim's token: a later claim of the same row (after the lease lapsed, or a
    // redelivery) sets a new one, so this result cannot overwrite its.
    expect(update.where).toEqual({ claimToken: 'claim-1', id: 'd-1', status: 'PENDING' });
    expect(update.data).toMatchObject({ lastStatusCode: 200, status: 'DELIVERED' });
  });

  it('signs with the previous secret too while it is in its overlap', async () => {
    const ep = endpoint();
    const rotated = rotatedEndpointSecretColumns(ep.columns, NOW);
    prisma.outboundDelivery.findUnique.mockResolvedValue(
      delivery({ endpoint: { ...ep.columns, ...rotated.data } })
    );
    await attemptDelivery(
      { attempts: 1, claimToken: 'claim-1', id: 'd-1' },
      { now: () => NOW, send: sendOk }
    );
    const input = (sendOk.mock.calls[0] as unknown as [SendCallbackInput])[0];
    expect(input.secrets).toEqual([rotated.secret, ep.secret]);
  });

  it('schedules a retry with backoff and records only a status code and an error class', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(delivery());
    expect(
      await attemptDelivery(
        { attempts: 3, claimToken: 'claim-1', id: 'd-1' },
        { now: () => NOW, send: send500 }
      )
    ).toBe('retrying');
    const update = lastUpdate();
    expect(update.data).toEqual({
      lastError: 'HTTP_STATUS',
      lastStatusCode: 500,
      nextAttemptAt: new Date(NOW.getTime() + 4 * 60_000),
    });
  });

  it('goes DEAD once the next try would fall outside the 24 h window', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(
      delivery({ retryWindowStartedAt: new Date(NOW.getTime() - 23 * 3600_000) })
    );
    expect(
      await attemptDelivery(
        { attempts: 11, claimToken: 'claim-1', id: 'd-1' },
        { now: () => NOW, send: send500 }
      )
    ).toBe('dead');
    expect(lastUpdate().data).toMatchObject({
      deadReason: 'RETRIES_EXHAUSTED',
      lastError: 'HTTP_STATUS',
      lastStatusCode: 500,
      status: 'DEAD',
    });
  });

  // Built lazily: sealing needs the key the `beforeAll` sets.
  it.each([
    ['ENDPOINT_DELETED', () => ({ endpoint: null })],
    ['ENDPOINT_DISABLED', () => ({ endpoint: endpoint({ disabledAt: NOW }).columns })],
    ['CALLBACK_GONE', () => ({ runCallback: null })],
    // The endpoint's prefix was narrowed after the launch named a URL under the old one.
    ['ENDPOINT_CHANGED', () => ({ endpoint: endpoint({ pathPrefix: '/other' }).columns })],
    [
      'ENDPOINT_CHANGED',
      () => ({ endpoint: endpoint({ origin: 'https://moved.example.com' }).columns }),
    ],
  ])('goes DEAD with %s without sending', async (reason, overrides) => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(delivery(overrides()));
    expect(
      await attemptDelivery(
        { attempts: 1, claimToken: 'claim-1', id: 'd-1' },
        { now: () => NOW, send: sendOk }
      )
    ).toBe('dead');
    expect(sendOk).not.toHaveBeenCalled();
    expect(lastUpdate().data).toMatchObject({ deadReason: reason, status: 'DEAD' });
  });

  it('never logs the URL path or query, only the origin', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(
      delivery({ endpoint: endpoint({ disabledAt: NOW }).columns })
    );
    await attemptDelivery(
      { attempts: 1, claimToken: 'claim-1', id: 'd-1' },
      { now: () => NOW, send: sendOk }
    );
    const logged = JSON.stringify(vi.mocked(logWarn).mock.calls);
    expect(logged).not.toContain('receiver-secret');
    // Not the path either: it can be a secret of its own.
    expect(logged).not.toContain('/hooks/run');
    expect(logged).toContain('https://hooks.example.com');
  });

  it('reports nothing when a later claim of the row holds the token', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(delivery());
    prisma.outboundDelivery.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await attemptDelivery(
        { attempts: 1, claimToken: 'stale', id: 'd-1' },
        { now: () => NOW, send: sendOk }
      )
    ).toBeNull();
  });

  it('leaves a row that is no longer pending alone', async () => {
    prisma.outboundDelivery.findUnique.mockResolvedValue(delivery({ status: 'DELIVERED' }));
    expect(
      await attemptDelivery({ attempts: 1, claimToken: 'claim-1', id: 'd-1' }, { send: sendOk })
    ).toBeNull();
    expect(sendOk).not.toHaveBeenCalled();
    expect(prisma.outboundDelivery.updateMany).not.toHaveBeenCalled();
  });
});

describe('deliverCallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims due rows with FOR UPDATE SKIP LOCKED and counts the outcomes', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { attempts: 1, claimToken: 'claim-1', id: 'd-1' },
      { attempts: 1, claimToken: 'claim-2', id: 'd-2' },
    ]);
    prisma.outboundDelivery.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'd-1' ? delivery() : delivery({ endpoint: null, id: 'd-2' })
    );
    const result = await deliverCallbacks({ now: () => NOW, send: sendOk });
    expect(result).toEqual({ claimed: 2, dead: 1, delivered: 1, retrying: 0 });
    const sql = (prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('claim_token = gen_random_uuid()');
  });
});
