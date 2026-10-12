import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanStepRoutes } from './humanSteps.js';

/**
 * `GET /human-steps?answeredByMe=true` against real Postgres: the filter is a relational
 * `OR` (the caller resolved the step, or has an approval row on it) ANDed with the visibility,
 * status and run filters, which a mocked Prisma would not evaluate.
 *
 * Opt in with `HUMAN_STEPS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 *
 * Alice's runs hold every shape of step; bob's run is invisible to alice (she is on no team and
 * did not request it), though steps on it name her as the resolver.
 */
const enabled = process.env.HUMAN_STEPS_PG_TEST === '1';

type Item = { id: string; myResponse: string | null; status: string; runId: string };
type Page = { data: Item[]; meta?: { limit: number; offset: number; total: number } };

describe.skipIf(!enabled)('human-step list against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;
  const base = new Date('2026-01-01T00:00:00Z').getTime();

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: throwaway database', ['WorkflowTemplate'], fn);

  const list = async (user: string, query = ''): Promise<Page> => {
    const res = await app.inject({
      headers: { authorization: `Bearer ${ids[user]}` },
      method: 'GET',
      url: `/api/v1/human-steps?${query}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Page;
  };
  const stepIds = (page: Page) => page.data.map((s) => s.id).sort();
  const present = (...keys: string[]) => keys.map((k) => ids[k]).filter((v): v is string => !!v);
  const want = (...keys: string[]) => keys.map((k) => ids[k]).sort();

  let n = 0;
  const step = (
    key: string,
    run: string,
    data: {
      kind?: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
      status?: 'PENDING' | 'RESOLVED' | 'TIMED_OUT' | 'CANCELLED';
      resolvedBy?: string;
      payload?: object;
      requiredApprovers?: number;
    }
  ) =>
    prisma.workflowHumanStep
      .create({
        data: {
          kind: data.kind ?? 'APPROVAL',
          nodeId: `node-${key}`,
          payload: data.payload,
          requestedAt: new Date(base + n++ * 1000),
          requiredApprovers: data.requiredApprovers ?? 1,
          resolvedAt: data.status === 'RESOLVED' ? new Date() : undefined,
          resolvedBy: data.resolvedBy ? ids[data.resolvedBy] : undefined,
          runId: ids[run],
          signalName: `sig-${key}`,
          status: data.status ?? 'PENDING',
          title: `${key}-${suffix}`,
        },
      })
      .then((s) => {
        ids[key] = s.id;
        return s;
      });
  const approval = (stepKey: string, user: string, action: string) =>
    prisma.humanApproval.create({
      data: { action, resolvedBy: ids[user], stepId: ids[stepKey] },
    });

  beforeAll(async () => {
    for (const key of ['alice', 'bob', 'admin']) {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `hs-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
            ...(key === 'admin' ? { role: 'ADMIN' as const } : {}),
          },
        })
      ).id;
    }
    await unscoped(async () => {
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `hs-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
    });
    for (const [key, owner] of [
      ['runA', 'alice'],
      ['runA2', 'alice'],
      ['runB', 'bob'],
    ] as const) {
      const wr = await prisma.runInput.create({
        data: {
          description: `hs ${key} ${suffix}`,
          externalTicketId: `HS-${key}-${suffix}`,
          requestedById: ids[owner],
          requestPayload: '{}',
        },
      });
      ids[key] = (
        await prisma.workflowRun.create({
          data: {
            specSnapshot: {},
            status: 'RUNNING',
            templateId: ids.tpl,
            templateVersion: 1,
            // Alice controls her own runs, so she can answer their pending steps.
            ...(owner === 'alice' ? { launchedById: ids.alice } : {}),
            workflowId: `wf-${key}-${suffix}`,
            workRequestId: wr.id,
          },
        })
      ).id;
    }

    // Alice resolved these on her own run.
    await step('approved', 'runA', {
      payload: { action: 'approve' },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    await step('rejected', 'runA', {
      payload: { action: 'reject' },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    await step('decided', 'runA', {
      kind: 'DECISION',
      payload: { action: 'choose', value: 'ship' },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    // A resolved step whose stored payload names no action falls back to `respond`.
    await step('input', 'runA', {
      kind: 'INPUT',
      payload: { value: { a: 1 } },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    // Multi-approver, still pending: alice has an approval row but is not the resolver.
    await step('multiPending', 'runA', { requiredApprovers: 2 });
    await approval('multiPending', 'alice', 'approve');
    // Multi-approver, completed by bob after alice approved.
    await step('multiDone', 'runA', {
      payload: { action: 'approve' },
      requiredApprovers: 2,
      resolvedBy: 'bob',
      status: 'RESOLVED',
    });
    await approval('multiDone', 'alice', 'approve');
    await approval('multiDone', 'bob', 'approve');
    // Not alice's: answered by bob, bob's approval row only, a timeout, a cancel, and untouched.
    await step('byBob', 'runA', {
      payload: { action: 'approve' },
      resolvedBy: 'bob',
      status: 'RESOLVED',
    });
    await step('bobRow', 'runA', { requiredApprovers: 2 });
    await approval('bobRow', 'bob', 'approve');
    await step('timedOut', 'runA', { status: 'TIMED_OUT' });
    await step('cancelled', 'runA', { status: 'CANCELLED' });
    await step('pending', 'runA', {});
    // A second run, for the runId filter.
    await step('approved2', 'runA2', {
      payload: { action: 'approve' },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    // Bob's run: alice cannot see it, whoever resolved the step.
    await step('hidden', 'runB', {
      payload: { action: 'approve' },
      resolvedBy: 'alice',
      status: 'RESOLVED',
    });
    await step('hiddenRow', 'runB', { requiredApprovers: 2 });
    await approval('hiddenRow', 'alice', 'approve');
  });

  afterAll(async () => {
    const people = present('alice', 'bob', 'admin');
    // Tolerates a failed beforeAll: only ids that were created are matched, never `undefined`.
    await prisma.workflowRun.deleteMany({
      where: { id: { in: present('runA', 'runA2', 'runB') } }, // cascades steps
    });
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: { in: present('tpl') } } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9999999999,
        iat: 0,
        role: token === ids.admin ? 'ADMIN' : 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
    await app.ready();
  });

  it('matches every step the caller resolved or has an approval row on, across statuses', async () => {
    const page = await list('alice', 'answeredByMe=true&status=ALL');
    expect(stepIds(page)).toEqual(
      want('approved', 'rejected', 'decided', 'input', 'multiPending', 'multiDone', 'approved2')
    );
    expect(page.meta).toEqual({ limit: 200, offset: 0, total: 7 });
  });

  it('leaves out steps answered by someone else, timed out, cancelled, or untouched', async () => {
    const got = stepIds(await list('alice', 'answeredByMe=true&status=ALL'));
    for (const key of ['byBob', 'bobRow', 'timedOut', 'cancelled', 'pending']) {
      expect(got).not.toContain(ids[key]);
    }
  });

  it("reports the caller's own response for resolved and multi-approver rows", async () => {
    const page = await list('alice', 'answeredByMe=true&status=ALL');
    const mine = Object.fromEntries(page.data.map((s) => [s.id, s.myResponse]));
    expect(mine[ids.approved]).toBe('approve');
    expect(mine[ids.rejected]).toBe('reject');
    expect(mine[ids.decided]).toBe('choose');
    expect(mine[ids.input]).toBe('respond');
    expect(mine[ids.multiPending]).toBe('approve');
    // Alice's row is reported even though bob completed the step.
    expect(mine[ids.multiDone]).toBe('approve');
    // A step bob answered, or that timed out, carries no response for alice.
    const all = await list('alice', 'status=ALL');
    expect(all.data.find((s) => s.id === ids.byBob)?.myResponse).toBeNull();
    expect(all.data.find((s) => s.id === ids.timedOut)?.myResponse).toBeNull();
  });

  it('is ANDed with the default pending status', async () => {
    const page = await list('alice', 'answeredByMe=true');
    expect(stepIds(page)).toEqual(want('multiPending'));
    expect(page.meta).toEqual({ limit: 100, offset: 0, total: 1 });
  });

  it('is ANDed with the runId filter', async () => {
    const page = await list('alice', `answeredByMe=true&status=ALL&runId=${ids.runA2}`);
    expect(stepIds(page)).toEqual(want('approved2'));
    expect(page.meta?.total).toBe(1);
  });

  it('is ANDed with visibility: a step on a run the caller cannot see never appears', async () => {
    const page = await list('alice', 'answeredByMe=true&status=ALL');
    expect(stepIds(page)).not.toContain(ids.hidden);
    expect(stepIds(page)).not.toContain(ids.hiddenRow);
    const direct = await list('alice', `answeredByMe=true&status=ALL&runId=${ids.runB}`);
    expect(direct.data).toEqual([]);
    expect(direct.meta?.total).toBe(0);
    // An ADMIN sees every run, but answeredByMe still means answered by the admin.
    const admin = await list('admin', `answeredByMe=true&status=ALL&runId=${ids.runB}`);
    expect(admin.data).toEqual([]);
  });

  it('is disjoint from actionable: a step the caller answered is not waiting on them', async () => {
    // Pending steps on alice's controlled runs that she has not answered.
    const actionable = await list('alice', 'actionable=true');
    expect(stepIds(actionable)).toEqual(want('bobRow', 'pending'));
    const both = await list('alice', 'answeredByMe=true&actionable=true');
    expect(both.data).toEqual([]);
    expect(both.meta?.total).toBe(0);
  });

  it('does not show bob the steps he answered on a run he cannot see', async () => {
    const page = await list('bob', 'answeredByMe=true&status=ALL');
    expect(page.data).toEqual([]);
    expect(page.meta?.total).toBe(0);
  });

  it('pages with limit and offset, and total counts every match', async () => {
    const query = 'answeredByMe=true&status=ALL&sort=requestedAt:asc';
    const first = await list('alice', `${query}&limit=3`);
    const second = await list('alice', `${query}&limit=3&offset=3`);
    const third = await list('alice', `${query}&limit=3&offset=6`);
    expect(first.data).toHaveLength(3);
    expect(second.data).toHaveLength(3);
    expect(third.data).toHaveLength(1);
    expect(first.meta).toEqual({ limit: 3, offset: 0, total: 7 });
    expect(second.meta).toEqual({ limit: 3, offset: 3, total: 7 });
    expect(third.meta).toEqual({ limit: 3, offset: 6, total: 7 });
    const seen = [...first.data, ...second.data, ...third.data].map((s) => s.id);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(0, 3)).toEqual([ids.approved, ids.rejected, ids.decided]);
  });

  it('includes meta only when a total was asked for', async () => {
    expect((await list('alice', 'status=ALL')).meta).toBeUndefined();
    expect((await list('alice', '')).meta).toBeUndefined();
    expect((await list('alice', 'limit=5')).meta?.limit).toBe(5);
    expect((await list('alice', 'offset=1')).meta?.offset).toBe(1);
    expect((await list('alice', 'answeredByMe=true')).meta).toBeDefined();
    expect((await list('alice', 'answeredByMe=false')).meta).toBeUndefined();
  });

  it('lists everything visible with status=ALL and only pending steps by default', async () => {
    const all = await list('alice', 'status=ALL');
    expect(all.data.some((s) => s.id === ids.hidden)).toBe(false);
    expect(all.data.some((s) => s.id === ids.timedOut)).toBe(true);
    const pending = await list('alice');
    expect(pending.data.every((s) => s.status === 'PENDING')).toBe(true);
    expect(stepIds(pending)).toEqual(want('multiPending', 'bobRow', 'pending'));
  });
});
