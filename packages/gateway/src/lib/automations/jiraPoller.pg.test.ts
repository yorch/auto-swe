import crypto from 'node:crypto';
import { JIRA_FILTER_NEW_ISSUE } from '@auto-swe/shared/automation';
import { prisma } from '@auto-swe/shared/db';
import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workflow.jiraPollProjectKeys' ? ['PAY'] : true
  ),
}));

import { connectionInclude, type EngineConnection } from './engine.js';
import {
  connectionOwnerKey,
  engineDecider,
  type PollableAutomation,
  pollAutomation,
} from './jiraPoller.js';

/**
 * The poller's lease and its seen set against real Postgres, and its hand-off to the real
 * engine: the lease is a compare-and-set that only one of two replicas may win, and the ledger's
 * unique dedupe key is what keeps a crash between a decision and its mark from starting a second
 * run. A mocked Prisma would only pretend to show either.
 *
 * Opt in with `CI_TRIGGER_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes rows, so use a throwaway one); see engine.pg.test.ts for the recipe.
 */
const enabled = process.env.CI_TRIGGER_PG_TEST === '1';

/** What `ticket-to-merge` takes of a run that comes from a ticket. */
const TICKET_RUN_SCHEMA: InputSchema = {
  properties: {
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    ticketId: { type: 'string' },
  },
  required: ['connectionId', 'description', 'ticketId'],
  type: 'object',
};

describe.skipIf(!enabled)('Jira filter polling against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  let automationId: string;
  let automation: PollableAutomation;
  let repoId: string;
  let ownerKey: string;
  const startedWorkflows: string[] = [];

  /** Executions Temporal reports as over. */
  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma,
    temporal: {
      isWorkflowGone: async () => true,
      startRunnableWorkflow: async (id: string) => {
        startedWorkflows.push(id);
      },
    },
  };

  const hit = (key: string) => ({ key, projectKey: key.split('-')[0] ?? '', summary: key });
  const issues = [hit('PAY-1'), hit('PAY-2')];
  const issueFor = (key: string) => ({
    description: `Description of ${key}`,
    id: key,
    labels: [],
    raw: {},
    status: 'To Do',
    title: `Summary of ${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
  });
  /** Takes long enough that two concurrent polls overlap while the first holds the lease. */
  const slowTracker = (found = issues) => ({
    fetchIssue: vi.fn(async (key: string) => issueFor(key)),
    searchIssues: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { issues: found, truncated: false };
    }),
  });
  const noDecision = async () => {
    throw new Error('no decision was expected');
  };
  const deps = (
    tracker = slowTracker(),
    now = new Date(),
    decide: never = noDecision as never
  ) => ({
    decide,
    now,
    prisma,
    tracker,
  });

  /** The real engine, for the automation as the database holds it. */
  const realDecider = async (now = new Date()) => {
    const row = await prisma.automation.findUniqueOrThrow({ where: { id: automationId } });
    const connection = (await prisma.connection.findFirstOrThrow({
      include: connectionInclude,
      where: { id: repoId },
    })) as EngineConnection;
    return engineDecider(fastify as never, { automation: row, connection, now, ownerKey });
  };

  beforeAll(async () => {
    await runUnscoped(
      'test fixture: throwaway database',
      ['Organization', 'Team', 'Connection', 'Automation', 'WorkflowTemplate'],
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
        const template = await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            inputSchema: TICKET_RUN_SCHEMA as object,
            name: `jp-tpl-${suffix}`,
            status: 'ACTIVE',
            teamId: team.id,
          },
        });
        const row = await prisma.automation.create({
          data: {
            connectionId: repo.id,
            cooldownMinutes: 0,
            filters: { jql: 'status = Open' },
            maxRunsPerDay: 100,
            name: 'jira',
            source: JIRA_FILTER_NEW_ISSUE,
            templateId: template.id,
          },
        });
        repoId = repo.id;
        automationId = row.id;
        ownerKey = connectionOwnerKey(repo, 'https://github.com') ?? '';
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
    startedWorkflows.length = 0;
    await prisma.automationSeenIssue.deleteMany({ where: { automationId } });
    await prisma.automationPollState.deleteMany({ where: { automationId } });
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
  });

  afterAll(async () => {
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
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
      fetchIssue: vi.fn(),
      searchIssues: vi.fn(async () => {
        await prisma.automationPollState.update({
          data: { leaseUntil: theirs },
          where: { automationId },
        });
        return { issues, truncated: false };
      }),
    };
    await pollAutomation(deps(tracker as never), automation);
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
      fetchIssue: vi.fn(),
      searchIssues: vi.fn(async () => {
        throw new Error('internal-host refused with a token abc123');
      }),
    };
    const outcome = await pollAutomation(deps(tracker as never), automation);
    expect(outcome).toEqual({ code: 'TRACKER_UNAVAILABLE', status: 'error' });
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.lastError).toBe('TRACKER_UNAVAILABLE');
    expect(state.leaseUntil).toBeNull();
    expect(state.baselinedAt).toBeNull();
  });

  describe('with the real engine', () => {
    const poll = async (found = issues) =>
      pollAutomation(
        deps(slowTracker(found), new Date(), (await realDecider()) as never),
        automation
      );

    it('starts one run for a new issue, records it in the ledger, and starts none on a later poll', async () => {
      expect((await poll()).status).toBe('baselined');
      const withNew = [...issues, hit('PAY-3')];
      expect(await poll(withNew)).toEqual({
        pending: 0,
        started: 1,
        status: 'polled',
        suppressed: 0,
      });
      expect(startedWorkflows).toHaveLength(1);
      expect(startedWorkflows[0]).toMatch(/^jirapoll-[0-9a-f]{8}-pay-3$/);
      const fires = await prisma.automationFire.findMany({ where: { ownerKey } });
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({ outcome: 'STARTED', subjectKey: 'jira-pay-3' });

      expect(await poll(withNew)).toEqual({
        pending: 0,
        started: 0,
        status: 'polled',
        suppressed: 0,
      });
      expect(startedWorkflows).toHaveLength(1);
    });

    it('starts no second run when a poll crashed after the decision and before the mark', async () => {
      await poll();
      await poll([...issues, hit('PAY-3')]);
      expect(startedWorkflows).toHaveLength(1);
      // The crash: the decision stands, the key was never marked seen.
      await prisma.automationSeenIssue.delete({
        where: { automationId_issueKey: { automationId, issueKey: 'pay-3' } },
      });
      const outcome = await poll([...issues, hit('PAY-3')]);
      expect(outcome).toEqual({ pending: 0, started: 0, status: 'polled', suppressed: 0 });
      expect(startedWorkflows).toHaveLength(1);
      const marked = await prisma.automationSeenIssue.count({
        where: { automationId, issueKey: 'pay-3' },
      });
      expect(marked).toBe(1);
    });

    it('marks an issue seen when the daily cap suppresses it, and starts nothing', async () => {
      await prisma.automation.update({ data: { maxRunsPerDay: 1 }, where: { id: automationId } });
      try {
        await poll();
        const outcome = await poll([...issues, hit('PAY-3'), hit('PAY-4')]);
        expect(outcome).toEqual({ pending: 0, started: 1, status: 'polled', suppressed: 1 });
        expect(startedWorkflows).toHaveLength(1);
        const seen = await prisma.automationSeenIssue.findMany({ where: { automationId } });
        expect(seen.map((s) => s.issueKey).sort()).toEqual(['pay-1', 'pay-2', 'pay-3', 'pay-4']);
      } finally {
        await prisma.automation.update({
          data: { maxRunsPerDay: 100 },
          where: { id: automationId },
        });
      }
    });
  });
});
