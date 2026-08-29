import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { webhookRoutes } from './webhooks.js';

/**
 * `POST /api/v1/webhooks/:token` — the public, token-secured generic trigger.
 *
 * Its sender is an external system, which is exactly the caller most likely to
 * retry a delivery it never saw a response for. Without an `Idempotency-Key`
 * the workflow ID is random, so a retry silently starts a second run.
 */

const TEMPLATE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SHORT_TPL_ID = TEMPLATE_ID.replace(/-/g, '').slice(0, 8);
const TOKEN = 'tok_abcdef0123456789';

interface Harness {
  app: FastifyInstance;
  started: string[];
  startInputs: unknown[];
  order: string[];
  runInputs: Array<Record<string, unknown>>;
  activeWorkflows: Array<Record<string, unknown>>;
  startError?: Error;
}

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

async function buildHarness(): Promise<Harness> {
  const h: Harness = {
    activeWorkflows: [],
    app: Fastify(),
    order: [],
    runInputs: [],
    started: [],
    startInputs: [],
  };

  h.app.setValidatorCompiler(validatorCompiler);
  h.app.setSerializerCompiler(serializerCompiler);
  await h.app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  const prismaMock: Record<string, unknown> = {
    activeWorkflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (h.activeWorkflows.some((a) => a.temporalWorkflowId === data.temporalWorkflowId)) {
          throw uniqueViolation();
        }
        const row = { id: `aw-${h.activeWorkflows.length + 1}`, ...data };
        h.activeWorkflows.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        h.activeWorkflows = h.activeWorkflows.filter((a) => a.id !== where.id);
        return {};
      },
    },
    runInput: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.runInputs.push(data);
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        h.runInputs = h.runInputs.filter((r) => r.id !== where.id);
        return {};
      },
    },
    workflowTemplate: {
      findUnique: async ({ where }: { where: { webhookToken?: string } }) =>
        where.webhookToken === TOKEN
          ? {
              activeVersion: 2,
              id: TEMPLATE_ID,
              inputSchema: null,
              status: 'ACTIVE',
              team: { slug: 'platform' },
            }
          : null,
    },
  };
  prismaMock.$transaction = async (ops: Promise<unknown>[]) => {
    h.order.push('ledger');
    return Promise.all(ops);
  };
  h.app.decorate('prisma', prismaMock as unknown as never);

  h.app.decorate('temporal', {
    signalWorkflow: async () => {},
    startRunnableWorkflow: async (id: string, input: unknown) => {
      h.order.push('start');
      if (h.startError) {
        throw h.startError;
      }
      h.started.push(id);
      h.startInputs.push(input);
    },
  } as unknown as never);

  h.app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await h.app.ready();
  return h;
}

function fire(h: Harness, key?: string) {
  return h.app.inject({
    headers: key ? { 'idempotency-key': key } : {},
    method: 'POST',
    payload: { description: 'nightly sweep' },
    url: `/api/v1/webhooks/${TOKEN}`,
  });
}

describe('POST /webhooks/:token', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('starts a run and writes the ledger first', async () => {
    const res = await fire(h);

    expect(res.statusCode).toBe(201);
    expect(h.order).toEqual(['ledger', 'start']);
  });

  it('404s an unknown token without touching the ledger', async () => {
    const res = await h.app.inject({
      method: 'POST',
      payload: {},
      url: '/api/v1/webhooks/tok_wrong',
    });

    expect(res.statusCode).toBe(404);
    expect(h.runInputs).toHaveLength(0);
  });

  it('starts a distinct run per delivery when no Idempotency-Key is sent', async () => {
    await fire(h);
    await fire(h);
    expect(h.started).toHaveLength(2);
  });

  it('collapses a redelivered event with the same Idempotency-Key onto one run', async () => {
    const first = await fire(h, 'evt-1001');
    const second = await fire(h, 'evt-1001');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(h.started).toHaveLength(1);
  });

  it('derives a stable workflow ID from the key', async () => {
    await fire(h, 'evt-1001');
    expect(h.started[0]).toMatch(new RegExp(`^wh-${SHORT_TPL_ID}-[0-9a-f]{16}$`));
  });

  it('keys are scoped per endpoint prefix, so a template-run key cannot alias a webhook run', async () => {
    await fire(h, 'shared-key');
    // Same key, different prefix — the `wh-` trigger must not collide with the
    // `wf-` template-run endpoint.
    expect(h.started[0].startsWith('wh-')).toBe(true);
  });

  it('rejects an over-long Idempotency-Key', async () => {
    const res = await fire(h, 'x'.repeat(256));
    expect(res.statusCode).toBe(400);
    expect(h.started).toHaveLength(0);
  });

  it('leaves no orphan ledger rows when the start fails', async () => {
    h.startError = new Error('temporal unreachable');

    await fire(h);

    expect(h.runInputs).toHaveLength(0);
    expect(h.activeWorkflows).toHaveLength(0);
  });

  it('passes the generic payload and connectionId through to the workflow', async () => {
    const payload = {
      connectionId: 'conn-1',
      message: 'hello',
      ticketId: 'WEB-1',
    };
    const res = await h.app.inject({
      method: 'POST',
      payload,
      url: `/api/v1/webhooks/${TOKEN}`,
    });

    expect(res.statusCode).toBe(201);
    expect(h.startInputs).toHaveLength(1);
    const input = h.startInputs[0] as { request: Record<string, unknown> };
    expect(input.request.connectionId).toBe('conn-1');
    expect(input.request.repoId).toBe('conn-1');
    expect(input.request.externalTicketId).toBe('WEB-1');
    expect(input.request.payload).toEqual(payload);
    expect(input.request.requestPayload).toBe(JSON.stringify(payload));
  });
});
