import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveCanaryConfig: vi.fn(async () => ({ enabled: false })),
  resolveFigmaConfig: vi.fn(async () => ({ enabled: false })),
  resolveIssueTrackerConfig: vi.fn(async () => ({ provider: null })),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({ enabled: false, provider: null })),
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));

import { workRequestRoutes } from './workRequests.js';

/**
 * `Idempotency-Key` on `POST /work-requests` against real Postgres: the unique index and the
 * transaction are the mechanism, so a mocked Prisma would prove nothing about the race.
 *
 * Opt in with `WORK_REQUEST_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one):
 *
 *   docker run -d --rm --name pr5-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55452:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55452/t yarn workspace @auto-swe/shared db:deploy
 *   WORK_REQUEST_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/routes/workRequests.idempotency.pg.test.ts
 */
const enabled = process.env.WORK_REQUEST_PG_TEST === '1';

describe.skipIf(!enabled)('POST /work-requests Idempotency-Key against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  let userA: string;
  let userB: string;
  let repoId: string;
  let otherRepoId: string;
  let userC: string;
  let teamId: string;
  let orgId: string;
  let templateId: string;
  const started: string[] = [];
  let failStart = false;
  let startError: Error | null = null;
  let startDelayMs = 0;
  let seq = 0;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: throwaway database', ['Team', 'Connection', 'WorkflowTemplate'], fn);

  const submit = (
    opts: {
      user?: string;
      key?: string;
      ticket?: string;
      description?: string;
      budget?: 'STANDARD' | 'LARGE';
      repo?: string;
    } = {}
  ) =>
    app.inject({
      headers: {
        authorization: `Bearer ${opts.user ?? userA}`,
        ...(opts.key !== undefined ? { 'idempotency-key': opts.key } : {}),
      },
      method: 'POST',
      payload: {
        ...(opts.budget ? { budgetTier: opts.budget } : {}),
        description: opts.description ?? 'Add a health endpoint',
        externalTicketId: opts.ticket ?? 'IDEM-1',
        repoIds: [opts.repo ?? repoId],
      },
      url: '/api/v1/work-requests',
    });

  const runInputs = (ticket: string) =>
    prisma.runInput.findMany({
      include: { activeWorkflows: true },
      where: { externalTicketId: ticket },
    });

  beforeAll(async () => {
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map((n) =>
        prisma.user.create({
          data: { email: `idem-${n}-${suffix}@example.test`, emailVerified: true, name: n },
        })
      )
    );
    userA = a.id;
    userB = b.id;
    userC = c.id;
    await unscoped(async () => {
      const org = await prisma.organization.create({
        data: { name: `idem-org-${suffix}`, slug: `idem-org-${suffix}` },
      });
      orgId = org.id;
      const team = await prisma.team.create({
        data: { name: `idem-team-${suffix}`, orgId, slug: `idem-team-${suffix}` },
      });
      teamId = team.id;
      const repo = await prisma.connection.create({
        data: {
          organizationName: `idem-${suffix}`,
          repoName: 'repo',
          teamId,
          type: 'git_repo',
        },
      });
      repoId = repo.id;
      const other = await prisma.connection.create({
        data: { organizationName: `idem-${suffix}`, repoName: 'other', teamId, type: 'git_repo' },
      });
      otherRepoId = other.id;
      const tpl = await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          isDefault: true,
          name: `idem-default-${suffix}`,
          status: 'ACTIVE',
          teamId,
        },
      });
      templateId = tpl.id;
    });
    for (const userId of [userA, userB, userC]) {
      await prisma.organizationMembership.create({ data: { orgId, userId } });
      await prisma.teamMembership.create({ data: { teamId, userId } });
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9999999999,
        iat: 0,
        role: 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('temporal', {
      startRunnableWorkflow: async (id: string) => {
        if (startDelayMs) {
          await new Promise((r) => setTimeout(r, startDelayMs));
        }
        if (startError) {
          throw startError;
        }
        if (failStart) {
          throw new Error('temporal unavailable');
        }
        started.push(id);
      },
    } as unknown as never);
    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  beforeEach(() => {
    failStart = false;
    startError = null;
    startDelayMs = 0;
    started.length = 0;
    seq++;
  });

  afterAll(async () => {
    await prisma.activeWorkflow.deleteMany({ where: { repoId: { in: [repoId, otherRepoId] } } });
    await prisma.runInput.deleteMany({ where: { connectionId: { in: [repoId, otherRepoId] } } });
    await prisma.orgMonthlyUsage.deleteMany({ where: { orgId } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: templateId } });
      await prisma.connection.deleteMany({ where: { id: { in: [repoId, otherRepoId] } } });
      await prisma.team.deleteMany({ where: { id: teamId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB, userC] } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('returns the original ids with deduplicated: true on the same key and params', async () => {
    const ticket = `SAME-${seq}`;
    const first = await submit({ key: 'k1', ticket });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.deduplicated).toBeUndefined();
    const second = await submit({ key: 'k1', ticket });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data).toEqual({ ...first.json().data, deduplicated: true });
    expect(started).toHaveLength(1);
    expect(await runInputs(ticket)).toHaveLength(1);
  });

  it('rejects the same key with different params as 422', async () => {
    const ticket = `MISMATCH-${seq}`;
    expect((await submit({ key: 'k2', ticket })).statusCode).toBe(201);
    for (const other of [
      { description: 'something else' },
      { ticket: `${ticket}-other` },
      { budget: 'LARGE' as const },
      { repo: otherRepoId },
    ]) {
      const res = await submit({ key: 'k2', ticket, ...other });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    }
    expect(started).toHaveLength(1);
  });

  it('yields exactly one run for concurrent same-key requests', async () => {
    const ticket = `RACE-${seq}`;
    startDelayMs = 30;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => submit({ key: 'race-key', ticket }))
    );
    // One winner. Every other request either already sees the started run (200) or lost the
    // race while the start was still in flight, which is a retryable "in progress" -- never a
    // second run, and never the ticket's "already running" conflict.
    const winners = results.filter((r) => r.statusCode === 201);
    expect(winners, results.map((r) => r.body).join('\n')).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      if (r.statusCode === 409) {
        expect(r.json().error.code, r.body).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
        expect(r.headers['retry-after']).toBeDefined();
      } else {
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().data.workRequestId).toBe(winners[0].json().data.workRequestId);
      }
    }
    expect(started).toHaveLength(1);
    const rows = await runInputs(ticket);
    expect(rows).toHaveLength(1);
    expect(rows[0].activeWorkflows).toHaveLength(1);
    // Once the start has finished, the same key replays with the original ids.
    const after = await submit({ key: 'race-key', ticket });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().data).toEqual({ ...winners[0].json().data, deduplicated: true });
  });

  it('does not replay a launch whose Temporal start is still in flight (sequential)', async () => {
    const ticket = `INPROG-${seq}`;
    startDelayMs = 400;
    failStart = true;
    const first = submit({ key: 'slow', ticket });
    await new Promise((r) => setTimeout(r, 150));
    const during = await submit({ key: 'slow', ticket });
    expect(during.statusCode, during.body).toBe(409);
    expect(during.json().error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(during.headers['retry-after']).toBeDefined();
    expect((await first).statusCode).toBeGreaterThanOrEqual(500);
    // The run never existed, and the key is free again.
    expect(await runInputs(ticket)).toHaveLength(0);
    failStart = false;
    startDelayMs = 0;
    expect((await submit({ key: 'slow', ticket })).statusCode).toBe(201);
  });

  it('never reports success for concurrent same-key requests when the start fails', async () => {
    const ticket = `INPROG-RACE-${seq}`;
    startDelayMs = 200;
    failStart = true;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => submit({ key: 'slow-race', ticket }))
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(0);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(0);
    expect(await runInputs(ticket)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it('tells a loser whose conflicting winner has since compensated to retry, not that a run exists', async () => {
    const ticket = `RETRY-${seq}`;
    // The conflict is observed once (the winner's rows were there), then the winner
    // compensates: the next look at the ticket finds nothing running.
    const spy = vi.spyOn(prisma.activeWorkflow, 'findMany').mockImplementationOnce((async () => [
      {
        currentStatus: 'IMPLEMENTING',
        repoId,
        temporalWorkflowId: `eng-idem-${suffix}-repo-${ticket}`,
        workRequest: { externalTicketId: ticket },
      },
    ]) as never);
    try {
      const res = await submit({ key: 'lost', ticket });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_RETRY');
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(started).toHaveLength(0);
    expect((await submit({ key: 'lost', ticket })).statusCode).toBe(201);
  });

  it('keeps the ordinary conflict, not retry, when Temporal already runs an execution no row accounts for', async () => {
    const ticket = `ORPHANED-EXEC-${seq}`;
    startError = Object.assign(new Error('already started'), {
      name: 'WorkflowExecutionAlreadyStartedError',
    });
    const res = await submit({ key: 'orphaned-exec', ticket });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('WORKFLOW_ALREADY_EXISTS');
    expect(await runInputs(ticket)).toHaveLength(0);
  });

  it('does not leave a replayable row when compensation itself fails', async () => {
    const ticket = `ORPHAN-${seq}`;
    // Simulate a crashed compensation: the ledger rows exist but the start never confirmed.
    const wr = await prisma.runInput.create({
      data: {
        connectionId: repoId,
        description: 'Add a health endpoint',
        externalTicketId: ticket,
        idempotencyKey: 'orphan',
        payload: {
          budget: 'STANDARD',
          connectionId: repoId,
          description: 'Add a health endpoint',
          ticketId: ticket,
        },
        requestedById: userA,
        requestPayload: '{}',
      },
    });
    const awf = await prisma.activeWorkflow.create({
      data: {
        currentStatus: 'IMPLEMENTING',
        repoId,
        temporalWorkflowId: `eng-orphan-${suffix}-${seq}`,
        workRequestId: wr.id,
      },
    });
    const res = await submit({ key: 'orphan', ticket });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(res.json().data).toBeUndefined();
    await prisma.activeWorkflow.delete({ where: { id: awf.id } });
  });

  it('replays exactly the original launch, not a later re-run of the same request', async () => {
    const ticket = `ORIG-${seq}`;
    const first = await submit({ key: 'orig', ticket });
    expect(first.statusCode).toBe(201);
    await prisma.activeWorkflow.create({
      data: {
        currentStatus: 'IMPLEMENTING',
        repoId,
        temporalWorkflowId: `eng-rerun-${suffix}-${seq}`,
        workRequestId: first.json().data.workRequestId,
      },
    });
    const replay = await submit({ key: 'orig', ticket });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data.workflowIds).toEqual(first.json().data.workflowIds);
  });

  it('refuses a replay to a caller who has since lost access to the repository', async () => {
    const ticket = `REVOKED-${seq}`;
    expect((await submit({ key: 'revoked', ticket, user: userC })).statusCode).toBe(201);
    await prisma.teamMembership.deleteMany({ where: { teamId, userId: userC } });
    try {
      const fresh = await submit({ key: 'other-key', ticket: `${ticket}-x`, user: userC });
      expect(fresh.statusCode).toBe(403);
      const replay = await submit({ key: 'revoked', ticket, user: userC });
      expect(replay.statusCode, replay.body).toBe(403);
      expect(replay.json().data).toBeUndefined();
    } finally {
      await prisma.teamMembership.create({ data: { teamId, userId: userC } });
    }
  });

  it('replays a started launch even when the org has since reached its budget cap', async () => {
    const ticket = `CAP-${seq}`;
    const first = await submit({ key: 'cap', ticket });
    expect(first.statusCode).toBe(201);
    await prisma.organization.update({ data: { monthlyBudgetUsdCents: 1 }, where: { id: orgId } });
    const ym = new Date().toISOString().slice(0, 7);
    await prisma.orgMonthlyUsage.upsert({
      create: { costUsdAccrued: 100, orgId, yearMonth: ym },
      update: { costUsdAccrued: 100 },
      where: { orgId_yearMonth: { orgId, yearMonth: ym } },
    });
    try {
      expect((await submit({ key: 'cap-new', ticket: `${ticket}-x` })).statusCode).toBe(402);
      const replay = await submit({ key: 'cap', ticket });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().data.deduplicated).toBe(true);
    } finally {
      await prisma.organization.update({
        data: { monthlyBudgetUsdCents: null },
        where: { id: orgId },
      });
      await prisma.orgMonthlyUsage.deleteMany({ where: { orgId } });
    }
  });

  it('keeps the in-flight 409 for two different keys on one ticket', async () => {
    const ticket = `INFLIGHT-${seq}`;
    expect((await submit({ key: `a-${seq}`, ticket })).statusCode).toBe(201);
    const res = await submit({ key: `b-${seq}`, ticket });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('WORKFLOW_ALREADY_EXISTS');
    expect(started).toHaveLength(1);
    expect(await runInputs(ticket)).toHaveLength(1);
  });

  it('keeps the in-flight 409 for a key-less request after a keyed one', async () => {
    const ticket = `MIXED-${seq}`;
    expect((await submit({ key: `a-${seq}`, ticket })).statusCode).toBe(201);
    expect((await submit({ ticket })).statusCode).toBe(409);
  });

  it('gives a finished ticket re-submitted with a new key an -rN id', async () => {
    const ticket = `RERUN-${seq}`;
    expect((await submit({ key: 'first', ticket })).statusCode).toBe(201);
    await prisma.activeWorkflow.updateMany({
      data: { currentStatus: 'COMPLETED' },
      where: { workRequest: { externalTicketId: ticket } },
    });
    const res = await submit({ key: 'second', ticket });
    expect(res.statusCode, res.body).toBe(201);
    expect(started).toHaveLength(2);
    expect(started[1]).toBe(`${started[0]}-r1`);
  });

  it('frees the key when the Temporal start fails', async () => {
    const ticket = `FAIL-${seq}`;
    failStart = true;
    const failed = await submit({ key: 'retry-me', ticket });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(await runInputs(ticket)).toHaveLength(0);
    failStart = false;
    const retry = await submit({ key: 'retry-me', ticket });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(started).toHaveLength(1);
  });

  it('does not collide across users', async () => {
    const ticket = `USERS-${seq}`;
    const a = await submit({ key: 'shared-key', ticket, user: userA });
    expect(a.statusCode, a.body).toBe(201);
    // A different user, same key, different ticket: not a replay of A's run, not a 422.
    const b = await submit({ key: 'shared-key', ticket: `${ticket}-b`, user: userB });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json().data.workRequestId).not.toBe(a.json().data.workRequestId);
  });

  it('treats a request without the header as it always has', async () => {
    const ticket = `NOKEY-${seq}`;
    expect((await submit({ ticket })).statusCode).toBe(201);
    expect((await submit({ ticket })).statusCode).toBe(409);
    const rows = await runInputs(ticket);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBeNull();
  });

  it('rejects an empty or oversized key', async () => {
    expect((await submit({ key: '' })).statusCode).toBe(400);
    expect((await submit({ key: 'x'.repeat(256) })).statusCode).toBe(400);
  });
});
