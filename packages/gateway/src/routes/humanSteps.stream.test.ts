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

import { humanStepRoutes } from './humanSteps.js';

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

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
    } as unknown as never);
    app.decorate('prisma', {
      workflowHumanStep: {
        findMany: async () => {
          if (hold) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return [];
        },
      },
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
});
