import crypto from 'node:crypto';
import { JIRA_FILTER_NEW_ISSUE } from '@auto-swe/shared/automation';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAY']
  ),
}));

import { type PollableAutomation, pollAutomation } from './jiraPoller.js';

/**
 * The poller's lease and its seen set against real Postgres: the lease is a compare-and-set that
 * only one of two replicas may win, which a mocked Prisma would only pretend to show.
 *
 * Opt in with `CI_TRIGGER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes rows, so use a throwaway one); see engine.pg.test.ts for the recipe.
 */
const enabled = process.env.CI_TRIGGER_PG_TEST === '1';

describe.skipIf(!enabled)('Jira filter polling against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  let automationId: string;
  let automation: PollableAutomation;

  const issues = [
    { key: 'PAY-1', projectKey: 'PAY', summary: 'one' },
    { key: 'PAY-2', projectKey: 'PAY', summary: 'two' },
  ];
  /** Takes long enough that two concurrent polls overlap while the first holds the lease. */
  const slowTracker = () => {
    const searchIssues = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { issues, truncated: false };
    });
    return { searchIssues };
  };
  const deps = (tracker = slowTracker(), now = new Date()) => ({
    now,
    prisma,
    tracker,
  });

  beforeAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['Organization', 'Team', 'Connection', 'Automation'],
      async () => {
        const organization = await prisma.organization.create({
          data: { name: `jp-org-${suffix}`, slug: `jp-org-${suffix}` },
        });
        const team = await prisma.team.create({
          data: { name: `jp-team-${suffix}`, orgId: organization.id, slug: `jp-team-${suffix}` },
        });
        const repo = await prisma.connection.create({
          data: {
            organizationName: `jp-${suffix}`,
            repoName: 'repo',
            teamId: team.id,
            type: 'git_repo',
          },
        });
        const row = await prisma.automation.create({
          data: {
            connectionId: repo.id,
            filters: { jql: 'status = Open' },
            name: 'jira',
            source: JIRA_FILTER_NEW_ISSUE,
          },
        });
        automationId = row.id;
        automation = {
          connection: {
            id: repo.id,
            installation: null,
            isActive: true,
            team: { id: team.id, orgId: organization.id },
          },
          filters: row.filters,
          id: row.id,
        };
      }
    );
  });

  beforeEach(async () => {
    await prisma.automationSeenIssue.deleteMany({ where: { automationId } });
    await prisma.automationPollState.deleteMany({ where: { automationId } });
  });

  afterAll(async () => {
    await runUnscoped('test fixture', ['Automation'], () =>
      prisma.automation.deleteMany({ where: { id: automationId } })
    );
  });

  it('lets exactly one of two concurrent polls take the automation', async () => {
    const tracker = slowTracker();
    const [a, b] = await Promise.all([
      pollAutomation(deps(tracker), automation),
      pollAutomation(deps(tracker), automation),
    ]);
    expect([a.status, b.status].sort()).toEqual(['baselined', 'skipped']);
    expect(tracker.searchIssues).toHaveBeenCalledTimes(1);
  });

  it('releases the lease, so the next poll is not locked out', async () => {
    await pollAutomation(deps(), automation);
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.leaseUntil).toBeNull();
    expect(state.lastError).toBeNull();
    const again = await pollAutomation(deps(), automation);
    expect(again.status).toBe('polled');
  });

  it('takes over a lease that has expired and refuses one that has not', async () => {
    await prisma.automationPollState.create({
      data: { automationId, leaseUntil: new Date(Date.now() + 60_000) },
    });
    expect((await pollAutomation(deps(), automation)).status).toBe('skipped');
    await prisma.automationPollState.update({
      data: { leaseUntil: new Date(Date.now() - 1_000) },
      where: { automationId },
    });
    expect((await pollAutomation(deps(), automation)).status).toBe('baselined');
  });

  it('treats a lease that ends exactly now as held, and one a millisecond old as expired', async () => {
    const at = new Date('2026-10-27T12:00:00.000Z');
    await prisma.automationPollState.create({ data: { automationId, leaseUntil: at } });
    expect((await pollAutomation(deps(slowTracker(), at), automation)).status).toBe('skipped');
    const later = new Date(at.getTime() + 1);
    expect((await pollAutomation(deps(slowTracker(), later), automation)).status).toBe('baselined');
  });

  it('does not erase a lease another replica took while this poll was running', async () => {
    const theirs = new Date(Date.now() + 3_600_000);
    const tracker = {
      searchIssues: vi.fn(async () => {
        await prisma.automationPollState.update({
          data: { leaseUntil: theirs },
          where: { automationId },
        });
        return { issues, truncated: false };
      }),
    };
    await pollAutomation(deps(tracker), automation);
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.leaseUntil).toEqual(theirs);
  });

  it('baselines once: the keys are stored lower-case and a later poll does not baseline again', async () => {
    const first = await pollAutomation(deps(), automation);
    expect(first).toEqual({ recorded: 2, status: 'baselined' });
    const seen = await prisma.automationSeenIssue.findMany({
      orderBy: { issueKey: 'asc' },
      where: { automationId },
    });
    expect(seen.map((s) => s.issueKey)).toEqual(['pay-1', 'pay-2']);
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.baselinedAt).not.toBeNull();
    expect((await pollAutomation(deps(), automation)).status).toBe('polled');
  });

  it('records a fixed error code and still releases the lease when Jira fails', async () => {
    const tracker = {
      searchIssues: vi.fn(async () => {
        throw new Error('internal-host refused with a token abc123');
      }),
    };
    const outcome = await pollAutomation(deps(tracker), automation);
    expect(outcome).toEqual({ code: 'TRACKER_UNAVAILABLE', status: 'error' });
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.lastError).toBe('TRACKER_UNAVAILABLE');
    expect(state.leaseUntil).toBeNull();
    expect(state.baselinedAt).toBeNull();
  });
});
