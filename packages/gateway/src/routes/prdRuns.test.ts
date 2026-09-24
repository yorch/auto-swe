import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { prdRunRoutes } from './prdRuns.js';

/**
 * `POST /api/v1/prd-runs`.
 *
 * A PRD run keeps no `ActiveWorkflow` ledger row — its spend is summed from
 * `AgentTrace` at finalize, and the per-repo work requests it submits carry
 * their own rows. It still needs the `RunInput` written before Temporal starts,
 * so a DB failure cannot leave a decomposition running unattributed.
 */

const REPO_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

interface Harness {
  app: FastifyInstance;
  order: string[];
  runInputs: Array<Record<string, unknown>>;
  /** Any ActiveWorkflow write the route attempts — expected to stay empty. */
  activeWorkflowCreates: Array<Record<string, unknown>>;
  started: string[];
  startError?: Error;
  /** Platform role the token carries. */
  role: 'ADMIN' | 'LEAD';
  /** Whether the caller belongs to the repository's org. */
  orgMember: boolean;
  /** The org's accrued spend this month, in USD, against a 1000-cent cap. */
  orgSpentUsd: number;
}

async function buildHarness(): Promise<Harness> {
  const h: Harness = {
    activeWorkflowCreates: [],
    app: Fastify(),
    order: [],
    orgMember: true,
    orgSpentUsd: 0,
    role: 'ADMIN',
    runInputs: [],
    started: [],
  };

  h.app.setValidatorCompiler(validatorCompiler);
  h.app.setSerializerCompiler(serializerCompiler);
  h.app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: h.role, sub: 'user-1' }),
  } as unknown as never);

  const prismaMock: Record<string, unknown> = {
    activeWorkflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.activeWorkflowCreates.push(data);
        return { id: 'aw-1', ...data };
      },
      delete: async () => ({}),
    },
    connection: {
      findMany: async () => [
        {
          id: REPO_ID,
          organizationName: 'acme',
          repoName: 'payments',
          team: {
            memberships: [{ userId: 'user-1' }],
            organization: { id: 'org-1', monthlyBudgetUsdCents: 1000 },
            orgId: 'org-1',
          },
        },
      ],
    },
    organizationMembership: {
      findUnique: async () => (h.orgMember ? { role: 'ORG_MEMBER' } : null),
    },
    orgMonthlyUsage: {
      findUnique: async () => ({ costUsdAccrued: h.orgSpentUsd }),
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
      findFirst: async () => ({ activeVersion: 1, id: 'tpl-prd' }),
    },
  };
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
      // A PRD run writes no ActiveWorkflow row, so the unique index cannot
      // dedup it — Temporal's own already-started error is the only gate. The
      // fake has to model that or the dedup test passes vacuously.
      if (h.started.includes(id)) {
        const err = new Error('already started');
        err.name = 'WorkflowExecutionAlreadyStartedError';
        throw err;
      }
      h.started.push(id);
    },
  } as unknown as never);

  h.app.register(prdRunRoutes, { prefix: '/api/v1/prd-runs' });
  await h.app.ready();
  return h;
}

function submit(h: Harness, key?: string) {
  return h.app.inject({
    headers: { authorization: 'Bearer t', ...(key ? { 'idempotency-key': key } : {}) },
    method: 'POST',
    payload: {
      prdContent: 'As a user I want …',
      prdTitle: 'Payments revamp',
      repoIds: [REPO_ID],
    },
    url: '/api/v1/prd-runs',
  });
}

describe('POST /prd-runs', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('writes the RunInput before starting the workflow', async () => {
    const res = await submit(h);

    expect(res.statusCode).toBe(201);
    expect(h.order).toEqual(['ledger', 'start']);
    expect(h.runInputs).toHaveLength(1);
  });

  it('records the primary repository as the RunInput connection, so run visibility reaches its team', async () => {
    const res = await submit(h);

    expect(res.statusCode).toBe(201);
    expect(h.runInputs[0]).toMatchObject({ connectionId: REPO_ID, isCrossRepo: true });
  });

  it('writes no ActiveWorkflow row', async () => {
    const res = await submit(h);

    expect(res.statusCode).toBe(201);
    // A PRD run is not a tracked single-repo run; a ledger row here would put a
    // phantom entry in the dashboard and in the budget rollup. The mock accepts
    // the write, so this fails loudly if the route ever starts making one.
    expect(h.activeWorkflowCreates).toHaveLength(0);
  });

  it('compensates the RunInput when the start fails', async () => {
    h.startError = new Error('temporal unreachable');

    const res = await submit(h);

    expect(res.statusCode).toBe(500);
    // Without compensation this row would point at a workflow that never ran.
    expect(h.runInputs).toHaveLength(0);
  });

  it('mints a fresh run per submission when no Idempotency-Key is sent', async () => {
    await submit(h);
    await submit(h);
    expect(h.started).toHaveLength(2);
    expect(h.started[0]).not.toBe(h.started[1]);
  });

  it('collapses a resubmission with the same Idempotency-Key', async () => {
    const first = await submit(h, 'prd-42');
    const second = await submit(h, 'prd-42');

    expect(first.statusCode).toBe(201);
    // Before this the suffix was a slice of a fresh UUID, so every submission
    // minted a new id and this branch was unreachable — a double-clicked PRD
    // started two decompositions.
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('PRD_RUN_ALREADY_EXISTS');
    expect(h.started).toHaveLength(1);
  });

  it('keeps the title slug in the id so the Temporal UI stays readable', async () => {
    await submit(h, 'prd-42');
    expect(h.started[0]).toMatch(/^prd-payments-revamp-[0-9a-f]{16}$/);
  });

  it('treats different keys as different runs', async () => {
    await submit(h, 'prd-1');
    await submit(h, 'prd-2');
    expect(h.started).toHaveLength(2);
  });

  it('rejects a repo the caller cannot see before writing anything', async () => {
    const res = await h.app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {
        prdContent: 'x',
        prdTitle: 'y',
        repoIds: ['dddddddd-4444-4444-8444-dddddddddddd'],
      },
      url: '/api/v1/prd-runs',
    });

    expect(res.statusCode).toBe(404);
    expect(h.runInputs).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  it('refuses a caller outside the repository org before writing anything', async () => {
    h.role = 'LEAD';
    h.orgMember = false;
    const res = await submit(h);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(h.runInputs).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  it('refuses with 402 when the repository org is over its monthly cap', async () => {
    h.orgSpentUsd = 10;
    const res = await submit(h);
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('ORG_BUDGET_EXCEEDED');
    expect(h.started).toHaveLength(0);
  });
});
