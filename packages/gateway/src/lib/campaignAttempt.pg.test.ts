import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AttemptLockContext,
  AttemptRollback,
  checkAttemptUnderLock,
  writeAttemptRows,
} from './campaignAttempt.js';

/**
 * The attempt route's guard and conditional write against real Postgres. The route's correctness
 * rests on two database behaviours a mocked Prisma only echoes back: `SELECT … FOR UPDATE` on the
 * campaign row serializes concurrent starts (so two starts cannot both pass `maxParallel`), and the
 * `updateMany … WHERE state IN (…)` that moves the target to `RUNNING` loses to a remove that
 * committed after the locked re-read (and then rolls the whole ledger transaction back).
 *
 * This runs the REAL `checkAttemptUnderLock` and `writeAttemptRows` exported by `campaignAttempt.ts`,
 * composed in a transaction in the order `launchTrackedWorkflow` composes them (guard, then rows).
 * Every interleaving is staged: a transaction is seen waiting on the lock through `pg_stat_activity`
 * before the holder is released, so no sleep decides the outcome.
 *
 * Opt in with `CAMPAIGN_ATTEMPT_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.CAMPAIGN_ATTEMPT_PG_TEST === '1';

const PREFIX = `campatt-${crypto.randomBytes(4).toString('hex')}-`;
const uuid = () => crypto.randomUUID();

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped(
    'test fixture rows in a throwaway database',
    [
      'Campaign',
      'CampaignTarget',
      'ConfigSetting',
      'Connection',
      'OrganizationMembership',
      'Team',
      'TeamMembership',
      'WorkflowTemplate',
    ],
    fn
  );

describe.skipIf(!enabled)('the campaign attempt guard and write against Postgres', () => {
  const ids = {
    launcher: uuid(),
    newLauncher: uuid(),
    org: uuid(),
    team: uuid(),
    template: uuid(),
  };
  const runInputIds: string[] = [];
  let seq = 0;

  /** A campaign of the fixture team, with `maxParallel`. */
  async function makeCampaign(maxParallel: number) {
    seq += 1;
    const campaignId = uuid();
    const runInput = await prisma.runInput.create({
      data: { externalTicketId: `${PREFIX}campaign-${seq}`, requestPayload: '{}' },
    });
    runInputIds.push(runInput.id);
    await prisma.campaign.create({
      data: {
        description: 'Raise lodash everywhere',
        gate: 'OPENED',
        id: campaignId,
        launchedById: ids.launcher,
        maxOpenPullRequests: 10,
        maxParallel,
        name: `${PREFIX}campaign-${seq}`,
        orgId: ids.org,
        ownerTeamId: ids.team,
        plan: 'UNIFORM',
        state: 'ACTIVE',
        templateId: ids.template,
        templateVersion: 1,
        temporalWorkflowId: `campaign-${campaignId}`,
        workflowKind: 'RECONCILER',
        workRequestId: runInput.id,
      },
    });
    return campaignId;
  }

  async function makeTarget(campaignId: string, position: number, state = 'PENDING') {
    seq += 1;
    const connection = await prisma.connection.create({
      data: { organizationName: 'acme', repoName: `${PREFIX}repo-${seq}`, teamId: ids.team },
    });
    const row = await prisma.campaignTarget.create({
      data: {
        campaignId,
        connectionId: connection.id,
        position,
        repoLabel: `acme/${PREFIX}repo-${seq}`,
        state: state as never,
        teamId: ids.team,
      },
    });
    return row.id;
  }

  /** The context the route builds before it takes the lock. */
  const lockContext = (campaignId: string, targetId: string, maxParallel: number) =>
    ({
      campaign: { gate: 'OPENED', id: campaignId, maxOpenPullRequests: 10, maxParallel },
      hasCheck: false,
      launcherId: ids.launcher,
      priorN: 0,
      targetId,
    }) satisfies AttemptLockContext;

  /**
   * One start, composed as `launchTrackedWorkflow` composes it: the guard under the campaign lock,
   * and only if it passes, the rows. `between` runs after the guard passed and before the write,
   * while the lock is held. Resolves to `'started'` or the refusal code.
   */
  async function start(
    campaignId: string,
    targetId: string,
    maxParallel: number,
    between?: () => Promise<void>
  ): Promise<string> {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const refusal = await checkAttemptUnderLock(
            tx,
            lockContext(campaignId, targetId, maxParallel)
          );
          if (refusal) {
            return refusal.code;
          }
          await between?.();
          await writeAttemptRows(tx, {
            childWorkflowId: `${PREFIX}wf-${targetId}`,
            n: 1,
            targetId,
            teamId: ids.team,
          });
          return 'started';
        },
        { timeout: 30_000 }
      );
    } catch (err) {
      if (err instanceof AttemptRollback) {
        return err.code;
      }
      throw err;
    }
  }

  /** Wait until some backend is blocked on a lock while running a statement like `needle`. */
  async function waitUntilBlocked(needle: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${needle}%`}`;
      if ((rows[0]?.n ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no backend was seen waiting on a lock for ${needle}`);
  }

  const attemptCount = (targetId: string) => prisma.campaignAttempt.count({ where: { targetId } });
  const stateOf = async (targetId: string) =>
    (await unscoped(() => prisma.campaignTarget.findFirst({ where: { id: targetId } })))?.state;

  async function cleanup() {
    await unscoped(async () => {
      await prisma.campaign.deleteMany({ where: { orgId: ids.org } });
      await prisma.connection.deleteMany({ where: { team: { orgId: ids.org } } });
    });
    await prisma.runInput.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } });
    await unscoped(async () => {
      await prisma.teamMembership.deleteMany({ where: { team: { orgId: ids.org } } });
      await prisma.organizationMembership.deleteMany({ where: { orgId: ids.org } });
      await prisma.team.deleteMany({ where: { orgId: ids.org } });
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.template } });
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.organization.deleteMany({ where: { id: ids.org } });
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.organization.create({
      data: { id: ids.org, name: `${PREFIX}org`, slug: `${PREFIX}org` },
    });
    await prisma.team.create({
      data: { id: ids.team, name: `${PREFIX}team`, orgId: ids.org, slug: `${PREFIX}team` },
    });
    await prisma.user.create({
      data: { email: `${PREFIX}launcher@example.test`, id: ids.launcher },
    });
    await prisma.user.create({
      data: { email: `${PREFIX}new@example.test`, id: ids.newLauncher },
    });
    await unscoped(() =>
      prisma.workflowTemplate.create({ data: { id: ids.template, name: `${PREFIX}template` } })
    );
  });

  afterAll(async () => {
    if (enabled) {
      await cleanup();
    }
    await prisma.$disconnect();
  });

  it('writes the attempt and moves the target to RUNNING when nothing changed', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0);
    expect(await start(campaignId, target, 2)).toBe('started');
    expect(await attemptCount(target)).toBe(1);
    expect(await stateOf(target)).toBe('RUNNING');
  });

  it('rolls the whole transaction back, writing no attempt, when a remove commits between the locked re-read and the write', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0);
    const outcome = await start(campaignId, target, 2, async () => {
      // The remove route does not take the campaign lock; it commits on its own connection while
      // this transaction holds it, after the guard's locked re-read saw the target `PENDING`.
      const removed = await unscoped(() =>
        prisma.campaignTarget.updateMany({
          data: { state: 'SKIPPED' },
          where: { id: target, state: 'PENDING' },
        })
      );
      expect(removed.count).toBe(1);
    });
    expect(outcome).toBe('TARGET_NOT_STARTABLE');
    expect(await attemptCount(target)).toBe(0);
    expect(await stateOf(target)).toBe('SKIPPED');
  });

  it('refuses a target a remove had already committed when the lock was taken', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0, 'SKIPPED');
    expect(await start(campaignId, target, 2)).toBe('TARGET_NOT_STARTABLE');
    expect(await attemptCount(target)).toBe(0);
  });

  it('lets exactly one of two concurrent starts through at maxParallel 1', async () => {
    const campaignId = await makeCampaign(1);
    const a = await makeTarget(campaignId, 0);
    const b = await makeTarget(campaignId, 1);
    let second: Promise<string> | undefined;
    const first = start(campaignId, a, 1, async () => {
      // The first holds the lock with its guard passed. The second is started now and is seen
      // waiting for that lock; only then does the first write and commit. Were the guard not taken
      // under the lock, the second would run its own guard at once and also pass.
      second = start(campaignId, b, 1);
      await Promise.race([waitUntilBlocked('campaigns WHERE id'), second]);
    });
    const results = [await first, await (second as Promise<string>)];
    expect([...results].sort()).toEqual(['MAX_PARALLEL', 'started']);
    expect(results[0]).toBe('started');
    expect((await attemptCount(a)) + (await attemptCount(b))).toBe(1);
    expect(await stateOf(a)).toBe('RUNNING');
    expect(await stateOf(b)).toBe('PENDING');
  });

  it('lets both through when the limit has room', async () => {
    const campaignId = await makeCampaign(2);
    const a = await makeTarget(campaignId, 0);
    const b = await makeTarget(campaignId, 1);
    let second: Promise<string> | undefined;
    const first = start(campaignId, a, 2, async () => {
      second = start(campaignId, b, 2);
      await Promise.race([waitUntilBlocked('campaigns WHERE id'), second]);
    });
    expect([await first, await (second as Promise<string>)]).toEqual(['started', 'started']);
  });

  it('refuses a start decided for a launcher a take-over replaced before the lock was taken', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0);
    await unscoped(() =>
      prisma.campaign.updateMany({
        data: { launchedById: ids.newLauncher },
        where: { id: campaignId, launchedById: ids.launcher },
      })
    );
    expect(await start(campaignId, target, 2)).toBe('LAUNCHER_UNAVAILABLE');
    expect(await attemptCount(target)).toBe(0);
    expect(await stateOf(target)).toBe('PENDING');
  });

  it('serializes a take-over that lands mid-start: it waits for the start, which ran for the old launcher', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0);
    let takeover: Promise<{ count: number }> | undefined;
    let takeoverSettled = false;
    const outcome = await start(campaignId, target, 2, async () => {
      takeover = unscoped(() =>
        prisma.campaign.updateMany({
          data: { launchedById: ids.newLauncher },
          where: { id: campaignId, launchedById: ids.launcher },
        })
      ).then((result) => {
        takeoverSettled = true;
        return result;
      });
      await Promise.race([waitUntilBlocked('UPDATE%campaigns'), takeover]);
      // Still waiting on the lock this transaction holds: it has not landed under the start.
      expect(takeoverSettled).toBe(false);
    });
    expect(outcome).toBe('started');
    expect((await (takeover as Promise<{ count: number }>)).count).toBe(1);
    expect(await attemptCount(target)).toBe(1);
    const row = await unscoped(() => prisma.campaign.findFirst({ where: { id: campaignId } }));
    expect(row?.launchedById).toBe(ids.newLauncher);
  });

  it('refuses a campaign cancelled before the lock was taken', async () => {
    const campaignId = await makeCampaign(2);
    const target = await makeTarget(campaignId, 0);
    await unscoped(() =>
      prisma.campaign.updateMany({ data: { state: 'CANCELLING' }, where: { id: campaignId } })
    );
    expect(await start(campaignId, target, 2)).toBe('CAMPAIGN_NOT_ACTIVE');
    expect(await attemptCount(target)).toBe(0);
  });
});
