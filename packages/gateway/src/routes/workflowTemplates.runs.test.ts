import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { workflowTemplateRoutes } from './workflowTemplates.js';

/**
 * `POST /workflow-templates/:id/runs` — the generic (non-SWE) run trigger.
 *
 * Two properties matter here and neither was covered before: the ledger rows are
 * written before Temporal starts, and an `Idempotency-Key` collapses a retry
 * onto the original run instead of starting a second one.
 */

const TEMPLATE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SHORT_TPL_ID = TEMPLATE_ID.replace(/-/g, '').slice(0, 8);

interface Harness {
  app: FastifyInstance;
  /** Every `temporalWorkflowId` the route asked Temporal to start. */
  started: string[];
  /** Ordered log of ledger writes vs. workflow starts. */
  order: string[];
  runInputs: Array<Record<string, unknown>>;
  activeWorkflows: Array<Record<string, unknown>>;
  /** Set to make `startRunnableWorkflow` throw. */
  startError?: Error;
}

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

function buildHarness(opts?: { inputSchema?: unknown }): Harness {
  const h: Harness = {
    activeWorkflows: [],
    app: Fastify(),
    order: [],
    runInputs: [],
    started: [],
  };

  h.app.setValidatorCompiler(validatorCompiler);
  h.app.setSerializerCompiler(serializerCompiler);
  h.app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'user-1' }),
  } as unknown as never);

  const prismaMock: Record<string, unknown> = {
    activeWorkflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // The real dedup gate: a unique index on temporalWorkflowId.
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
      findFirst: async () => ({
        activeVersion: 3,
        id: TEMPLATE_ID,
        inputSchema: opts?.inputSchema ?? null,
      }),
    },
  };
  // The route writes both ledger rows through $transaction's array form.
  prismaMock.$transaction = async (ops: Promise<unknown>[]) => {
    h.order.push('ledger');
    return Promise.all(ops);
  };
  h.app.decorate('prisma', prismaMock as unknown as never);

  h.app.decorate('temporal', {
    startRunnableWorkflow: async (id: string) => {
      h.order.push('start');
      if (h.startError) {
        throw h.startError;
      }
      h.started.push(id);
    },
  } as unknown as never);

  h.app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  return h;
}

function run(h: Harness, opts?: { key?: string; payload?: Record<string, unknown> }) {
  return h.app.inject({
    headers: {
      authorization: 'Bearer t',
      ...(opts?.key ? { 'idempotency-key': opts.key } : {}),
    },
    method: 'POST',
    payload: { payload: opts?.payload ?? { description: 'do the thing' } },
    url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
  });
}

describe('POST /workflow-templates/:id/runs', () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await h.app.ready();
  });

  it('writes the ledger before starting the workflow', async () => {
    const res = await run(h);

    expect(res.statusCode).toBe(201);
    // A start that precedes the ledger can leave a workflow burning budget with
    // no row to attribute it to.
    expect(h.order).toEqual(['ledger', 'start']);
    expect(h.runInputs).toHaveLength(1);
    expect(h.activeWorkflows).toHaveLength(1);
  });

  it('returns the ActiveWorkflow id it just wrote', async () => {
    const res = await run(h);
    expect(res.json().data.workflowId).toBe('aw-1');
  });

  it('starts a distinct run per request when no Idempotency-Key is sent', async () => {
    await run(h);
    await run(h);

    // Opt-in: unchanged behaviour for callers that send no key.
    expect(h.started).toHaveLength(2);
    expect(h.started[0]).not.toBe(h.started[1]);
  });

  it('collapses a retry with the same Idempotency-Key onto one run', async () => {
    const first = await run(h, { key: 'order-42' });
    const second = await run(h, { key: 'order-42' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('RUN_CONFLICT');
    // The second request must not have reached Temporal at all.
    expect(h.started).toHaveLength(1);
  });

  it('derives a stable workflow ID from the key', async () => {
    await run(h, { key: 'order-42' });
    expect(h.started[0]).toMatch(new RegExp(`^wf-${SHORT_TPL_ID}-[0-9a-f]{16}$`));
  });

  it('treats different keys as different runs', async () => {
    await run(h, { key: 'order-1' });
    await run(h, { key: 'order-2' });
    expect(h.started).toHaveLength(2);
  });

  it('keeps the caller key out of the workflow ID', async () => {
    await run(h, { key: 'secret-customer-reference' });
    expect(h.started[0]).not.toContain('secret');
  });

  it('rejects an over-long Idempotency-Key instead of hashing it anyway', async () => {
    const res = await run(h, { key: 'x'.repeat(256) });
    expect(res.statusCode).toBe(400);
    expect(h.started).toHaveLength(0);
  });

  it('leaves no orphan ledger rows when the start fails', async () => {
    h.startError = new Error('temporal unreachable');

    const res = await run(h);

    expect(res.statusCode).toBe(500);
    // Compensated — the inert failure mode, not an invisible running workflow.
    expect(h.runInputs).toHaveLength(0);
    expect(h.activeWorkflows).toHaveLength(0);
  });

  it('frees the idempotency key for retry when the start fails', async () => {
    h.startError = new Error('temporal unreachable');
    await run(h, { key: 'order-42' });

    // A transient Temporal outage must not permanently burn the key.
    h.startError = undefined;
    const retry = await run(h, { key: 'order-42' });

    expect(retry.statusCode).toBe(201);
    expect(h.started).toHaveLength(1);
  });

  it('still validates the payload against the template inputSchema', async () => {
    const strict = buildHarness({
      inputSchema: {
        properties: { ticketId: { type: 'string' } },
        required: ['ticketId'],
        type: 'object',
      },
    });
    await strict.app.ready();

    const res = await run(strict, { payload: { description: 'no ticket' } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(strict.started).toHaveLength(0);
  });
});
