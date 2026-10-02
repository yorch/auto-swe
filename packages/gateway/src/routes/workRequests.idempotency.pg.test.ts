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
  let teamId: string;
  let orgId: string;
  let templateId: string;
  const started: string[] = [];
  let failStart = false;
  let startDelayMs = 0;
  let seq = 0;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: throwaway database', ['Team', 'Connection', 'WorkflowTemplate'], fn);

  const submit = (
    opts: { user?: string; key?: string; ticket?: string; description?: string } = {}
  ) =>
    app.inject({
      headers: {
        authorization: `Bearer ${opts.user ?? userA}`,
        ...(opts.key !== undefined ? { 'idempotency-key': opts.key } : {}),
      },
      method: 'POST',
      payload: {
        description: opts.description ?? 'Add a health endpoint',
        externalTicketId: opts.ticket ?? 'IDEM-1',
        repoIds: [repoId],
      },
      url: '/api/v1/work-requests',
    });

  const runInputs = (ticket: string) =>
    prisma.runInput.findMany({
      include: { activeWorkflows: true },
      where: { externalTicketId: ticket },
    });

  beforeAll(async () => {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((n) =>
        prisma.user.create({
          data: { email: `idem-${n}-${suffix}@example.test`, emailVerified: true, name: n },
        })
      )
    );
    userA = a.id;
    userB = b.id;
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
    for (const userId of [userA, userB]) {
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
    startDelayMs = 0;
    started.length = 0;
    seq++;
  });

  afterAll(async () => {
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
    await prisma.runInput.deleteMany({ where: { connectionId: repoId } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: templateId } });
      await prisma.connection.deleteMany({ where: { id: repoId } });
      await prisma.team.deleteMany({ where: { id: teamId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
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
    for (const other of [{ description: 'something else' }, { ticket: `${ticket}-other` }]) {
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
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(new Set(results.map((r) => r.json().data.workRequestId)).size).toBe(1);
    expect(started).toHaveLength(1);
    const rows = await runInputs(ticket);
    expect(rows).toHaveLength(1);
    expect(rows[0].activeWorkflows).toHaveLength(1);
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
