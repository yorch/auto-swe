import crypto from 'node:crypto';
import { JIRA_FILTER_NEW_ISSUE, JIRA_FILTER_STATUS_CHANGED } from '@auto-swe/shared/automation';
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
const settings = vi.hoisted(() => ({ allowed: ['PAY'], polling: true }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workflow.jiraPollProjectKeys'
      ? settings.allowed
      : key === 'workflow.jiraPollAutomationsEnabled'
        ? settings.polling
        : true
  ),
}));

import { defaultTickDeps } from '../../plugins/jiraPoller.js';
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
  let templateId: string;
  let fixtureTeam: { id: string; orgId: string };
  let ownerKey: string;
  const startedWorkflows: string[] = [];
  /** The request each started run was handed, in order. */
  const startedRequests: { branchName?: string }[] = [];
  /** Whether Temporal reports every execution as over; a test sets false to leave a run open. */
  const runsAreOver = { value: true };

  /** Executions Temporal reports as over. */
  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma,
    temporal: {
      isWorkflowGone: async () => runsAreOver.value,
      startRunnableWorkflow: async (id: string, input: { request: { branchName?: string } }) => {
        startedWorkflows.push(id);
        startedRequests.push(input.request);
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
        templateId = template.id;
        fixtureTeam = { id: team.id, orgId: organization.id };
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
    settings.allowed = ['PAY'];
    settings.polling = true;
    startedWorkflows.length = 0;
    startedRequests.length = 0;
    runsAreOver.value = true;
    await prisma.automationSeenIssue.deleteMany({ where: { automationId } });
    await prisma.automationPollState.deleteMany({ where: { automationId } });
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
    await prisma.runInput.deleteMany({ where: { connectionId: repoId } });
  });

  afterAll(async () => {
    await prisma.automationFire.deleteMany({ where: { ownerKey } });
    await prisma.activeWorkflow.deleteMany({ where: { repoId } });
    await prisma.runInput.deleteMany({ where: { connectionId: repoId } });
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

  it('lists the automation polled longest ago first, one never polled before any', async () => {
    const other = await runUnscoped('test fixture', ['Automation'], () =>
      prisma.automation.create({
        data: {
          connectionId: repoId,
          filters: { jql: 'status = Open' },
          name: 'jira-other',
          source: JIRA_FILTER_NEW_ISSUE,
        },
      })
    );
    try {
      const list = async () => {
        const rows = await defaultTickDeps({ prisma } as never, () => false).listAutomations();
        return rows.map((r) => r.id).filter((id) => id === automationId || id === other.id);
      };
      // Neither has been polled: the older one first.
      expect(await list()).toEqual([automationId, other.id]);
      // The older was polled just now, so the one never polled goes first.
      await prisma.automationPollState.create({
        data: { automationId, lastPolledAt: new Date() },
      });
      expect(await list()).toEqual([other.id, automationId]);
      // Both polled: the one polled longest ago first.
      await prisma.automationPollState.create({
        data: { automationId: other.id, lastPolledAt: new Date(Date.now() - 3_600_000) },
      });
      expect(await list()).toEqual([other.id, automationId]);
      await prisma.automationPollState.update({
        data: { lastPolledAt: new Date(Date.now() - 7_200_000) },
        where: { automationId },
      });
      expect(await list()).toEqual([automationId, other.id]);
    } finally {
      await runUnscoped('test fixture', ['Automation'], () =>
        prisma.automation.deleteMany({ where: { id: other.id } })
      );
    }
  });

  it('reloads an automation as it is now, and nothing once it is off, removed or another source', async () => {
    const deps2 = defaultTickDeps({ prisma } as never, () => false);
    expect((await deps2.reload(automationId))?.id).toBe(automationId);
    await runUnscoped('test fixture', ['Automation'], () =>
      prisma.automation.update({ data: { enabled: false }, where: { id: automationId } })
    );
    try {
      expect(await deps2.reload(automationId)).toBeNull();
    } finally {
      await runUnscoped('test fixture', ['Automation'], () =>
        prisma.automation.update({ data: { enabled: true }, where: { id: automationId } })
      );
    }
    expect(await deps2.reload(crypto.randomUUID())).toBeNull();
  });

  it('marks an automation as attempted, creating its poll state if it has none', async () => {
    const deps2 = defaultTickDeps({ prisma } as never, () => false);
    await deps2.markAttempted(automationId);
    const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
    expect(state.lastPolledAt).not.toBeNull();
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

    it('takes a new baseline when the JQL changed, so what the new query already matched starts nothing', async () => {
      expect((await poll()).status).toBe('baselined');
      const changed = { ...automation, filters: { jql: 'status = Blocked' } };
      const found = [...issues, hit('PAY-9')];
      const rebaselined = await pollAutomation(
        deps(slowTracker(found), new Date(), (await realDecider()) as never),
        changed
      );
      expect(rebaselined).toEqual({ recorded: 3, status: 'baselined' });
      expect(startedWorkflows).toHaveLength(0);
      const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
      expect(state.baselineJql).toBe('project in ("PAY") AND (status = Blocked)');
      // The baseline now holds, so the next new issue under the new query does start a run.
      const next = await pollAutomation(
        deps(slowTracker([...found, hit('PAY-10')]), new Date(), (await realDecider()) as never),
        changed
      );
      expect(next).toEqual({ pending: 0, started: 1, status: 'polled', suppressed: 0 });
      expect(startedWorkflows).toHaveLength(1);
    });

    it('takes a new baseline when a project is added to the allowlist, so its old issues start nothing', async () => {
      expect((await poll()).status).toBe('baselined');
      settings.allowed = ['PAY', 'HR2'];
      const found = [...issues, hit('HR2-7')];
      expect(await poll(found)).toEqual({ recorded: 3, status: 'baselined' });
      expect(startedWorkflows).toHaveLength(0);
      const state = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
      expect(state.baselineJql).toBe('project in ("HR2", "PAY") AND (status = Open)');
    });

    it('takes a new baseline after the allowlist was emptied and restored, so what appeared meanwhile starts nothing', async () => {
      expect((await poll()).status).toBe('baselined');
      settings.allowed = [];
      expect(await poll()).toEqual({ code: 'NO_ALLOWED_PROJECTS', status: 'error' });
      const locked = await prisma.automationPollState.findUniqueOrThrow({
        where: { automationId },
      });
      expect(locked.baselinedAt).toBeNull();
      settings.allowed = ['PAY'];
      expect((await poll([...issues, hit('PAY-5')])).status).toBe('baselined');
      expect(startedWorkflows).toHaveLength(0);
    });

    it('takes a new baseline after polling was switched off and on, so what appeared meanwhile starts nothing', async () => {
      expect((await poll()).status).toBe('baselined');
      settings.polling = false;
      expect(await poll()).toEqual({ reason: 'switched-off', status: 'skipped' });
      const off = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
      expect(off.baselinedAt).toBeNull();
      expect(off.lastError).toBe('SWITCHED_OFF');
      settings.polling = true;
      // PAY-5 was created while polling was off.
      expect((await poll([...issues, hit('PAY-5')])).status).toBe('baselined');
      expect(startedWorkflows).toHaveLength(0);
      const on = await prisma.automationPollState.findUniqueOrThrow({ where: { automationId } });
      expect(on.lastError).toBeNull();
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
  describe('a status-change automation with the real engine', () => {
    let statusId: string;
    let statusAutomation: PollableAutomation;
    const inStatus = (key: string, status: string) => ({ ...hit(key), status });

    beforeAll(async () => {
      await runUnscoped('test fixture', ['Automation'], async () => {
        const row = await prisma.automation.create({
          data: {
            connectionId: repoId,
            cooldownMinutes: 0,
            filters: { jql: 'status = Open' },
            maxRunsPerDay: 100,
            name: 'jira status',
            source: JIRA_FILTER_STATUS_CHANGED,
            templateId,
          },
        });
        statusId = row.id;
        statusAutomation = {
          connection: {
            id: repoId,
            installation: null,
            isActive: true,
            team: fixtureTeam,
          },
          filters: row.filters,
          id: row.id,
          source: row.source,
        };
      });
    });

    beforeEach(async () => {
      await prisma.automationSeenIssue.deleteMany({ where: { automationId: statusId } });
      await prisma.automationPollState.deleteMany({ where: { automationId: statusId } });
    });

    afterAll(async () => {
      await prisma.automationFire.deleteMany({ where: { ownerKey } });
      await runUnscoped('test fixture', ['Automation'], () =>
        prisma.automation.deleteMany({ where: { id: statusId } })
      );
    });

    const poll = async (found: ReturnType<typeof inStatus>[]) => {
      const row = await prisma.automation.findUniqueOrThrow({ where: { id: statusId } });
      const connection = (await prisma.connection.findFirstOrThrow({
        include: connectionInclude,
        where: { id: repoId },
      })) as EngineConnection;
      const decide = engineDecider(fastify as never, {
        automation: row,
        connection,
        now: new Date(),
        ownerKey,
      });
      return pollAutomation(
        deps(slowTracker(found as never), new Date(), decide as never),
        statusAutomation
      );
    };
    const outcomes = async () =>
      (
        await prisma.automationFire.findMany({ orderBy: { createdAt: 'asc' }, where: { ownerKey } })
      ).map((f) => `${f.subjectKey}:${f.outcome}`);

    it('accepts the source in the database, and baselines pairs without starting a run', async () => {
      expect((await poll([inStatus('PAY-1', 'Open')])).status).toBe('baselined');
      const seen = await prisma.automationSeenIssue.findMany({ where: { automationId: statusId } });
      expect(seen.map((r) => r.issueKey)).toEqual(['pay-1#open']);
      expect(startedWorkflows).toHaveLength(0);
    });

    it('starts one run for each new status of an issue, and none when polled again', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      const moved = [inStatus('PAY-1', 'In Review')];
      expect(await poll(moved)).toEqual({
        pending: 0,
        started: 1,
        status: 'polled',
        suppressed: 0,
      });
      expect(startedWorkflows).toHaveLength(1);
      expect(startedWorkflows[0]).toMatch(/^jirapoll-[0-9a-f]{8}-pay-1-[0-9a-f]{8}$/);
      expect(await poll(moved)).toEqual({
        pending: 0,
        started: 0,
        status: 'polled',
        suppressed: 0,
      });
      expect(startedWorkflows).toHaveLength(1);
      const fires = await prisma.automationFire.findMany({ where: { ownerKey } });
      expect(fires).toHaveLength(1);
      expect(fires[0]?.dedupeKey).toBe(`${ownerKey}#jira-pay-1#in review`);
    });

    it('starts no second run when a poll crashed after the decision and before the mark', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      const moved = [inStatus('PAY-1', 'Ready')];
      await poll(moved);
      await prisma.automationSeenIssue.delete({
        where: {
          automationId_issueKey: { automationId: statusId, issueKey: 'pay-1#ready' },
        },
      });
      expect(await poll(moved)).toEqual({
        pending: 0,
        started: 0,
        status: 'polled',
        suppressed: 0,
      });
      expect(startedWorkflows).toHaveLength(1);
    });

    it('starts a run for every later transition once an earlier one STARTED, one subject per status', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      expect((await poll([inStatus('PAY-1', 'Ready')])).status).toBe('polled');
      expect((await poll([inStatus('PAY-1', 'Blocked')])).status).toBe('polled');
      expect((await poll([inStatus('PAY-1', 'QA')])).status).toBe('polled');
      expect(startedWorkflows).toHaveLength(3);
      expect(new Set(startedWorkflows).size).toBe(3);
      expect(await outcomes()).toEqual([
        'jira-pay-1#ready:STARTED',
        'jira-pay-1#blocked:STARTED',
        'jira-pay-1#qa:STARTED',
      ]);
    });

    it('suppresses a transition while the earlier run on the ticket is still open, and records it', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      await poll([inStatus('PAY-1', 'Ready')]);
      runsAreOver.value = false;
      expect(await poll([inStatus('PAY-1', 'Blocked')])).toEqual({
        pending: 0,
        started: 0,
        status: 'polled',
        suppressed: 1,
      });
      expect(startedWorkflows).toHaveLength(1);
      expect(await outcomes()).toEqual([
        'jira-pay-1#ready:STARTED',
        'jira-pay-1#blocked:SUPPRESSED_IN_FLIGHT',
      ]);
      // Counted as seen: the pair is not decided again when the run ends.
      runsAreOver.value = true;
      await poll([inStatus('PAY-1', 'Blocked')]);
      expect(startedWorkflows).toHaveLength(1);
    });

    it('gives every run on a ticket a branch of its own, decided once and carried in the run', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      await poll([inStatus('PAY-1', 'Ready')]);
      await poll([inStatus('PAY-1', 'Blocked')]);
      const branches = startedRequests.map((r) => r.branchName);
      expect(branches).toHaveLength(2);
      expect(new Set(branches).size).toBe(2);
      for (const branch of branches) {
        expect(branch).toMatch(/^auto\/PAY-1-[0-9a-f]{8}$/);
      }
      // The branch the request names is the one the active workflow and the run input keep.
      const rows = await prisma.activeWorkflow.findMany({ where: { repoId } });
      expect(rows.map((r) => r.assignedBranch).sort()).toEqual([...branches].sort());
      const inputs = await prisma.runInput.findMany({
        orderBy: { createdAt: 'asc' },
        where: { connectionId: repoId },
      });
      expect(inputs.map((r) => r.workBranch)).toEqual(branches);
    });

    it('leaves the branch of a new-issue run as it always was', async () => {
      const newIssuePoll = async (found: ReturnType<typeof hit>[]) =>
        pollAutomation(
          deps(slowTracker(found), new Date(), (await realDecider()) as never),
          automation
        );
      await newIssuePoll([]);
      await newIssuePoll([hit('PAY-5')]);
      expect(startedRequests).toHaveLength(1);
      expect(startedRequests[0]).not.toHaveProperty('branchName');
      const row = await prisma.activeWorkflow.findFirstOrThrow({ where: { repoId } });
      expect(row.assignedBranch).toBe('auto/PAY-5');
      const input = await prisma.runInput.findFirstOrThrow({ where: { connectionId: repoId } });
      expect(input.workBranch).toBeNull();
    });

    it('records the platform’s own move to In Progress, In Review and Done as suppressed, starting nothing', async () => {
      await poll([inStatus('PAY-1', 'Open')]);
      await poll([inStatus('PAY-1', 'Ready')]);
      expect(startedWorkflows).toHaveLength(1);
      expect(await poll([inStatus('PAY-1', 'In Progress')])).toEqual({
        pending: 0,
        started: 0,
        status: 'polled',
        suppressed: 1,
      });
      await poll([inStatus('PAY-1', 'In Review')]);
      await poll([inStatus('PAY-1', 'Done')]);
      expect(startedWorkflows).toHaveLength(1);
      expect(await outcomes()).toEqual([
        'jira-pay-1#ready:STARTED',
        'jira-pay-1#in progress:SUPPRESSED_OWN_OUTPUT',
        'jira-pay-1#in review:SUPPRESSED_OWN_OUTPUT',
        'jira-pay-1#done:SUPPRESSED_OWN_OUTPUT',
      ]);
    });

    it('still recognises it for a run of any age, in any repository, but not for a synthetic one', async () => {
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const stray = ['PAY-70', 'PAY-71'];
      try {
        await prisma.runInput.createMany({
          data: [
            // Another repository's (here: none) run, long ago.
            {
              createdAt: old,
              description: '',
              externalTicketId: 'PAY-70',
              requestPayload: '{}',
              ticketIsSynthetic: false,
            },
            {
              description: '',
              externalTicketId: 'PAY-71',
              requestPayload: '{}',
              ticketIsSynthetic: true,
            },
          ],
        });
        await poll([inStatus('PAY-70', 'Open'), inStatus('PAY-71', 'Open')]);
        await poll([inStatus('PAY-70', 'Done'), inStatus('PAY-71', 'Done')]);
        expect(await outcomes()).toEqual([
          'jira-pay-70#done:SUPPRESSED_OWN_OUTPUT',
          'jira-pay-71#done:STARTED',
        ]);
      } finally {
        await prisma.runInput.deleteMany({ where: { externalTicketId: { in: stray } } });
      }
    });

    it('acts on In Progress for a ticket the platform has no run on', async () => {
      await poll([inStatus('PAY-2', 'Open')]);
      expect((await poll([inStatus('PAY-2', 'In Progress')])).status).toBe('polled');
      expect(startedWorkflows).toHaveLength(1);
    });

    it('does not run on a ticket the new-issue source has an open run on', async () => {
      // The new-issue automation starts PAY-3; the status-change automation then sees it move.
      const newIssuePoll = async (found: ReturnType<typeof hit>[]) =>
        pollAutomation(
          deps(slowTracker(found), new Date(), (await realDecider()) as never),
          automation
        );
      await newIssuePoll([]);
      await newIssuePoll([hit('PAY-3')]);
      expect(startedWorkflows).toHaveLength(1);
      runsAreOver.value = false;
      await poll([inStatus('PAY-3', 'Open')]);
      expect(await poll([inStatus('PAY-3', 'Ready')])).toMatchObject({ started: 0, suppressed: 1 });
      expect(startedWorkflows).toHaveLength(1);
      const fire = await prisma.automationFire.findFirst({
        where: { outcome: 'SUPPRESSED_IN_FLIGHT', ownerKey },
      });
      expect(fire?.subjectKey).toBe('jira-pay-3#ready');
    });

    it('does not start a new-issue run on a ticket a status-change run has open', async () => {
      await poll([inStatus('PAY-4', 'Open')]);
      await poll([inStatus('PAY-4', 'Ready')]);
      expect(startedWorkflows).toHaveLength(1);
      runsAreOver.value = false;
      // The new-issue automation first sees PAY-4 now; its guard counts the other source's run.
      const newIssuePoll = async (found: ReturnType<typeof hit>[]) =>
        pollAutomation(
          deps(slowTracker(found), new Date(), (await realDecider()) as never),
          automation
        );
      await newIssuePoll([]);
      expect(await newIssuePoll([hit('PAY-4')])).toMatchObject({ started: 0, suppressed: 1 });
      expect(startedWorkflows).toHaveLength(1);
      const fire = await prisma.automationFire.findFirst({
        where: { outcome: 'SUPPRESSED_IN_FLIGHT', ownerKey, source: JIRA_FILTER_NEW_ISSUE },
      });
      expect(fire?.subjectKey).toBe('jira-pay-4');
    });

    it('rejects a Jira filter without a JQL, as for the sibling source', async () => {
      await expect(
        runUnscoped('test fixture', ['Automation'], () =>
          prisma.automation.create({
            data: {
              connectionId: repoId,
              filters: { jql: '  ' },
              name: 'bad',
              source: JIRA_FILTER_STATUS_CHANGED,
              templateId,
            },
          })
        )
      ).rejects.toThrow();
    });
  });
});
