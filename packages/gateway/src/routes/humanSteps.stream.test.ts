import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: {} } }));
vi.mock('../lib/hitlSlackSync.js', () => ({
  escapeSlackMrkdwn: (text: string) => text,
  syncSlackHumanStepOutcome: vi.fn(async () => undefined),
}));
vi.mock('../lib/slack.js', () => ({ postSlackMessage: vi.fn() }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: vi.fn(),
}));

import { humanStepRoutes, inboxStreamTuning } from './humanSteps.js';

/** Opens the stream and resolves with the request once the response head (or a 429) arrives. */
function openStream(port: number): Promise<{ req: http.ClientRequest; status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        headers: { authorization: 'Bearer test-token' },
        path: '/api/v1/human-steps/stream',
        port,
      },
      (res) => resolve({ req, status: res.statusCode ?? 0 })
    );
    req.on('error', reject);
  });
}

describe('GET /human-steps/stream', () => {
  const app = Fastify();
  let port = 0;
  let release: (() => void) | null = null;
  // The first stream's initial query stays open until the test lets it finish.
  let hold = false;
  let signature = { count: 0, newest: null as Date | null, oldest: null as Date | null };
  const aggregate = vi.fn(async () => {
    if (hold) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return {
      _count: { _all: signature.count },
      _max: { requestedAt: signature.newest },
      _min: { requestedAt: signature.oldest },
    };
  });
  const findMany = vi.fn(async () => []);

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
    } as unknown as never);
    app.decorate('prisma', {
      workflowHumanStep: { aggregate, findMany },
    } as unknown as never);
    await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(() => app.close());

  it('frees the per-user slot when the client leaves during the first query', async () => {
    // More disconnects than the per-user cap: each one must give its slot back, or the next
    // stream is refused with 429 and a 3 s database poll runs on for every one that leaked.
    for (let i = 0; i < 7; i += 1) {
      hold = true;
      const { req, status } = await openStream(port);
      expect(status).toBe(200);
      req.destroy();
      // Let the server see the socket close while the query is still pending.
      await new Promise((resolve) => setTimeout(resolve, 20));
      hold = false;
      release?.();
      release = null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { req, status } = await openStream(port);
    expect(status).toBe(200);
    req.destroy();
  });

  it('emits change only when the signature changes, and never lists ids', async () => {
    const original = inboxStreamTuning.pollMs;
    inboxStreamTuning.pollMs = 25;
    signature = { count: 1, newest: new Date(1000), oldest: new Date(1000) };
    findMany.mockClear();
    const chunks: string[] = [];
    const req = await new Promise<http.ClientRequest>((resolve, reject) => {
      const r = http.get(
        {
          headers: { authorization: 'Bearer test-token' },
          path: '/api/v1/human-steps/stream',
          port,
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c: string) => chunks.push(c));
          resolve(r);
        }
      );
      r.on('error', reject);
    });
    const changes = () => chunks.join('').split('event: change').length - 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(aggregate.mock.calls.length).toBeGreaterThan(2);
      expect(changes()).toBe(0);

      // One step resolved and one added: the count is the same, the newest timestamp moves.
      signature = { count: 1, newest: new Date(2000), oldest: new Date(2000) };
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(changes()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(changes()).toBe(1);

      signature = { count: 0, newest: null, oldest: null };
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(changes()).toBe(2);
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      inboxStreamTuning.pollMs = original;
      req.destroy();
    }
  });
});
