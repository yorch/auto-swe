import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStopNodeCache,
  NOT_ACTIONABLE_RERUN_WINDOW_MS,
  refuseUnchangedRerun,
  UNCHANGED_AFTER_NOT_ACTIONABLE,
} from './unchangedRerun.js';

/**
 * The not-actionable lookup against real Postgres. Every other test of it mocks `findMany`, which
 * cannot show that the JSON-path filters on the run's snapshots are accepted by Prisma and match
 * what a finished run stores, and a rejected filter would be swallowed as a warning, leaving the
 * guard silently off.
 *
 * Opt in with `UNCHANGED_RERUN_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes rows, so use a throwaway database):
 *
 *   docker run -d --rm --name rg-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55511:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55511/t yarn workspace @auto-swe/shared db:deploy
 *   UNCHANGED_RERUN_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/gateway/src/lib/unchangedRerun.pg.test.ts
 */
const enabled = process.env.UNCHANGED_RERUN_PG_TEST === '1';

const STOP_NODES = { nodes: { terminateNotActionable: { status: 'FAILED', type: 'terminate' } } };
const stoppedContext = { nodes: { validate: { output: { actionable: false } } } };

describe.skipIf(!enabled)('unchanged-request guard against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;
  let counter = 0;
  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'WorkflowTemplate', 'Organization'],
      fn
    );

  /** One ticket per case, so cases never see each other's runs. */
  const freshTicket = () => {
    counter += 1;
    return `UR-${counter}-${suffix}`;
  };
  const payloadFor = (ticketId: string, connectionId = ids.repoA) => ({
    budget: 'STANDARD',
    connectionId,
    description: 'https://jira.example.test/browse/X-1',
    ticketId,
  });

  async function runOf(opts: {
    ticketId: string;
    user?: string;
    connectionId?: string;
    status?: 'FAILED' | 'SUCCESS' | 'RUNNING';
    context?: unknown;
    spec?: unknown;
    startedAt?: Date;
    templateVersion?: number;
    workRequestId?: string;
  }) {
    const payload = payloadFor(opts.ticketId, opts.connectionId);
    const wr =
      opts.workRequestId !== undefined
        ? { id: opts.workRequestId }
        : await prisma.runInput.create({
            data: {
              connectionId: payload.connectionId,
              description: payload.description,
              externalTicketId: opts.ticketId,
              payload,
              requestedById: ids[opts.user ?? 'alice'],
              requestPayload: '{}',
              templateId: ids.tpl,
              templateVersion: opts.templateVersion ?? 1,
            },
          });
    counter += 1;
    return prisma.workflowRun.create({
      data: {
        contextSnapshot: (opts.context ?? stoppedContext) as never,
        specSnapshot: (opts.spec ?? STOP_NODES) as never,
        startedAt: opts.startedAt,
        status: opts.status ?? 'FAILED',
        templateId: ids.tpl,
        templateVersion: opts.templateVersion ?? 1,
        workflowId: `wf-ur-${counter}-${suffix}`,
        workRequestId: wr.id,
      },
    });
  }

  /** A template run with no ticket id: the repository alone narrows it, so crowding is possible. */
  async function ticketlessRun(opts: { description: string; startedAt: Date; stopped: boolean }) {
    const payload = { budget: 'STANDARD', connectionId: ids.repoA, description: opts.description };
    const wr = await prisma.runInput.create({
      data: {
        connectionId: ids.repoA,
        description: opts.description,
        externalTicketId: crypto.randomUUID(),
        payload,
        requestedById: ids.alice,
        requestPayload: '{}',
        templateId: ids.tpl,
        templateVersion: 1,
        ticketIsSynthetic: true,
      },
    });
    counter += 1;
    return prisma.workflowRun.create({
      data: {
        contextSnapshot: (opts.stopped ? stoppedContext : { error: 'failed at CI' }) as never,
        specSnapshot: STOP_NODES as never,
        startedAt: opts.startedAt,
        status: 'FAILED',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: `wf-ur-${counter}-${suffix}`,
        workRequestId: wr.id,
      },
    });
  }

  async function checkTicketless(description: string) {
    const reply = { send: vi.fn(() => reply), status: vi.fn(() => reply) };
    const log = { warn: vi.fn() };
    const refused = await refuseUnchangedRerun(
      { gate: undefined, log, prisma, user: { role: 'ENGINEER', sub: ids.alice } },
      {
        description,
        payload: { budget: 'STANDARD', connectionId: ids.repoA, description },
        templateId: ids.tpl,
        templateVersion: 1,
      },
      reply as never,
      undefined
    );
    expect(log.warn, JSON.stringify(log.warn.mock.calls)).not.toHaveBeenCalled();
    return refused;
  }

  async function crowded(description: string, withMatchingLaterRun: boolean) {
    const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
    await ticketlessRun({ description, startedAt: at(200), stopped: true });
    if (withMatchingLaterRun) {
      await ticketlessRun({ description, startedAt: at(190), stopped: false });
    }
    for (let i = 0; i < 30; i += 1) {
      await ticketlessRun({
        description: `unrelated ${i} ${description}`,
        startedAt: at(180 - i),
        stopped: false,
      });
    }
  }

  async function check(opts: { ticketId: string; user?: string; connectionId?: string }) {
    const reply = { send: vi.fn(() => reply), status: vi.fn(() => reply) };
    const log = { warn: vi.fn() };
    const user = opts.user ?? 'alice';
    const refused = await refuseUnchangedRerun(
      {
        gate: undefined,
        log,
        prisma,
        user: { role: 'ENGINEER', sub: ids[user] },
      },
      {
        description: payloadFor(opts.ticketId).description,
        payload: payloadFor(opts.ticketId, opts.connectionId),
        templateId: ids.tpl,
        templateVersion: 1,
      },
      reply as never,
      undefined
    );
    // A filter Prisma rejects is swallowed as a warning and reads as "launch": fail loudly.
    expect(log.warn, JSON.stringify(log.warn.mock.calls)).not.toHaveBeenCalled();
    const body = reply.send.mock.calls[0] as unknown as [
      { error: { code: string; details: { previousRunId: string } } },
    ];
    return { body: body?.[0], refused };
  }

  beforeEach(() => clearStopNodeCache());

  beforeAll(async () => {
    for (const key of ['alice', 'bob']) {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `ur-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
          },
        })
      ).id;
    }
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `ur-org-${suffix}`, slug: `ur-org-${suffix}` },
        })
      ).id;
      for (const [key, repo] of [
        ['A', 'repoA'],
        ['B', 'repoB'],
      ] as const) {
        ids[`team${key}`] = (
          await prisma.team.create({
            data: { name: `ur-${key}-${suffix}`, orgId: ids.org, slug: `ur-${key}-${suffix}` },
          })
        ).id;
        ids[repo] = (
          await prisma.connection.create({
            data: {
              organizationName: `ur-${suffix}`,
              repoName: `repo-${key}`,
              teamId: ids[`team${key}`],
              type: 'git_repo',
            },
          })
        ).id;
      }
      // GLOBAL, so no team sees a run through the template.
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `ur-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
      await prisma.workflowTemplateVersion.create({
        data: { spec: STOP_NODES, templateId: ids.tpl, version: 1 },
      });
    });
    await prisma.teamMembership.create({ data: { teamId: ids.teamA, userId: ids.alice } });
    await prisma.teamMembership.create({ data: { teamId: ids.teamB, userId: ids.bob } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses a request whose run stopped as not actionable, naming that run', async () => {
    const ticketId = freshTicket();
    const stop = await runOf({ ticketId });
    const { body, refused } = await check({ ticketId });
    expect(refused).toBe(true);
    expect(body.error.code).toBe(UNCHANGED_AFTER_NOT_ACTIONABLE);
    expect(body.error.details.previousRunId).toBe(stop.id);
  });

  it('matches the ticket id whatever its case', async () => {
    const ticketId = freshTicket();
    await runOf({ ticketId });
    expect((await check({ ticketId: ticketId.toLowerCase() })).refused).toBe(true);
  });

  it('launches when validation found the request actionable', async () => {
    const ticketId = freshTicket();
    await runOf({
      context: { nodes: { validate: { output: { actionable: true } } } },
      ticketId,
    });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when the run failed without a validation verdict', async () => {
    const ticketId = freshTicket();
    await runOf({ context: { error: 'boom' }, ticketId });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when the run stopped at a different terminate node', async () => {
    const ticketId = freshTicket();
    await runOf({
      spec: { nodes: { terminateSomethingElse: { status: 'FAILED', type: 'terminate' } } },
      ticketId,
    });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when the run did not fail', async () => {
    const ticketId = freshTicket();
    await runOf({ status: 'SUCCESS', ticketId });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when the stop is outside the window', async () => {
    const ticketId = freshTicket();
    await runOf({
      startedAt: new Date(Date.now() - NOT_ACTIONABLE_RERUN_WINDOW_MS - 60_000),
      ticketId,
    });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when the stop ran another version of the template', async () => {
    const ticketId = freshTicket();
    await runOf({ templateVersion: 2, ticketId });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it("launches, and names nothing, when the only stop is another team's run", async () => {
    const ticketId = freshTicket();
    await runOf({ connectionId: ids.repoB, ticketId, user: 'bob' });
    expect((await check({ connectionId: ids.repoB, ticketId })).refused).toBe(false);
    // The same request is refused for the team that can see its run.
    expect((await check({ connectionId: ids.repoB, ticketId, user: 'bob' })).refused).toBe(true);
  });

  it('launches when a later run of the same request exists, whatever its outcome', async () => {
    const ticketId = freshTicket();
    await runOf({ startedAt: new Date(Date.now() - 120_000), ticketId });
    await runOf({
      context: { error: 'failed at CI' },
      startedAt: new Date(Date.now() - 60_000),
      ticketId,
    });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('launches when a later run belongs to the same work request', async () => {
    const ticketId = freshTicket();
    const stop = await runOf({ startedAt: new Date(Date.now() - 120_000), ticketId });
    await runOf({
      context: { error: 'failed at CI' },
      startedAt: new Date(Date.now() - 60_000),
      ticketId,
      workRequestId: stop.workRequestId as string,
    });
    expect((await check({ ticketId })).refused).toBe(false);
  });

  it('cites the newest stop when a later run stopped too', async () => {
    const ticketId = freshTicket();
    await runOf({ startedAt: new Date(Date.now() - 120_000), ticketId });
    const newest = await runOf({ ticketId });
    const { body, refused } = await check({ ticketId });
    expect(refused).toBe(true);
    expect(body.error.details.previousRunId).toBe(newest.id);
  });

  it('launches when the run that overrode the stop is crowded out by 30 unrelated later runs', async () => {
    const description = `crowded-a ${suffix}`;
    await crowded(description, true);
    expect(await checkTicketless(description)).toBe(false);
  });

  it('still refuses when the only later runs are 30 unrelated ones', async () => {
    const description = `crowded-b ${suffix}`;
    await crowded(description, false);
    expect(await checkTicketless(description)).toBe(true);
  });

  it('launches a request that differs from the stopped one', async () => {
    const ticketId = freshTicket();
    await runOf({ ticketId });
    expect((await check({ ticketId: freshTicket() })).refused).toBe(false);
  });
});
