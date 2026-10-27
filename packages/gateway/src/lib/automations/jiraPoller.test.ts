import type { JiraFilterFacts } from '@auto-swe/shared/automation';
import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import type { IssueTrackerProvider } from '@auto-swe/shared/lib/integrations/issueTracker';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutomationResult, AutomationStartError } from './engine.js';

const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => settings);

import {
  connectionOwnerKey,
  hasBalancedParentheses,
  JIRA_POLL_MAX_MATCHES,
  type PollableAutomation,
  pollAutomation,
  wrapJqlInProjects,
} from './jiraPoller.js';

type SearchIssuesResult = Awaited<ReturnType<IssueTrackerProvider['searchIssues']>>;

const NOW = new Date('2026-10-27T12:00:00Z');
/** What a baseline is bound to: the query as Jira is asked it, the allowlist sorted. */
const NARROWED = 'project in ("OPS", "PAY") AND (status = Open)';

interface StateRow {
  automationId: string;
  baselinedAt: Date | null;
  /** The JQL the baseline was taken for. */
  baselineJql: string | null;
  lastPolledAt: Date | null;
  lastError: string | null;
  leaseUntil: Date | null;
}

/** The two tables the poller writes, in memory. The real lease race is in jiraPoller.pg.test.ts. */
function fakePrisma(initial: Partial<StateRow> = {}) {
  let state: StateRow | null = null;
  const seen = new Set<string>();
  const prisma = {
    automationPollState: {
      createMany: vi.fn(async ({ data }: { data: { automationId: string }[] }) => {
        if (state === null) {
          state = {
            automationId: data[0]?.automationId ?? '',
            baselinedAt: null,
            baselineJql: null,
            lastError: null,
            lastPolledAt: null,
            leaseUntil: null,
            ...initial,
          };
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findUniqueOrThrow: vi.fn(async () => {
        if (state === null) {
          throw new Error('no state row');
        }
        return { ...state };
      }),
      update: vi.fn(async ({ data }: { data: Partial<StateRow> }) => {
        state = { ...(state as StateRow), ...data };
        return { ...state };
      }),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Partial<StateRow>;
          where: {
            automationId: string;
            leaseUntil?: Date;
            OR?: [{ leaseUntil: null }, { leaseUntil: { lt: Date } }];
          };
        }) => {
          if (state === null || state.automationId !== where.automationId) {
            return { count: 0 };
          }
          // A claim takes a free or expired lease; a release only the lease its caller holds; an
          // update with no lease condition applies whoever holds the lease.
          const matches = where.OR
            ? state.leaseUntil === null || state.leaseUntil < where.OR[1].leaseUntil.lt
            : where.leaseUntil === undefined
              ? true
              : state.leaseUntil?.getTime() === where.leaseUntil.getTime();
          if (!matches) {
            return { count: 0 };
          }
          state = { ...state, ...data };
          return { count: 1 };
        }
      ),
    },
    automationSeenIssue: {
      createMany: vi.fn(async ({ data }: { data: { issueKey: string }[] }) => {
        for (const row of data) {
          seen.add(row.issueKey);
        }
        return { count: data.length };
      }),
      findMany: vi.fn(async ({ where }: { where: { issueKey: { in: string[] } } }) =>
        where.issueKey.in.filter((k) => seen.has(k)).map((issueKey) => ({ issueKey }))
      ),
    },
  };
  return {
    prisma,
    seen,
    state: () => state,
    /** Another replica takes the lease while a poll is running. */
    takeOver: (leaseUntil: Date) => {
      state = { ...(state as StateRow), leaseUntil };
    },
  };
}

const hit = (key: string, projectKey = key.split('-')[0] ?? '') => ({
  key,
  projectKey,
  summary: `Summary ${key}`,
});

const found = (...issues: ReturnType<typeof hit>[]): SearchIssuesResult => ({
  issues,
  truncated: false,
});

const automation = (over: Partial<PollableAutomation> = {}): PollableAutomation => ({
  connection: {
    id: 'conn-1',
    installation: null,
    isActive: true,
    team: { id: 'team-1', orgId: 'org-1' },
  },
  filters: { jql: 'status = Open' },
  id: 'auto-1',
  ...over,
});

const issueFor = (key: string, over: Record<string, unknown> = {}) => ({
  assignee: undefined,
  description: `Description of ${key}`,
  id: key,
  labels: [],
  raw: {},
  status: 'To Do',
  title: `Summary ${key}`,
  url: `https://acme.atlassian.net/browse/${key}`,
  ...over,
});

const started = (): AutomationResult => ({ automationId: 'auto-1', outcome: 'STARTED' });

type Extras = {
  fetchIssue?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
};

const run = (
  fake: ReturnType<typeof fakePrisma>,
  searchIssues: ReturnType<typeof vi.fn>,
  a: PollableAutomation = automation(),
  extras: Extras = {}
) =>
  pollAutomation(
    {
      decide: (extras.decide ?? vi.fn(async () => started())) as never,
      now: NOW,
      prisma: fake.prisma as never,
      tracker: {
        fetchIssue: extras.fetchIssue ?? vi.fn(async (key: string) => issueFor(key)),
        searchIssues,
      } as never,
    },
    a
  );

beforeEach(() => {
  settings.resolveSetting.mockReset();
  settings.resolveSetting.mockImplementation(async (key: string) =>
    key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAY', 'OPS']
  );
});

describe('wrapJqlInProjects', () => {
  it('narrows the query to the allowed projects, quoting each key', () => {
    expect(wrapJqlInProjects('status = Open', ['PAY', 'OPS'])).toBe(
      'project in ("PAY", "OPS") AND (status = Open)'
    );
  });
});

describe('pollAutomation: what it refuses to poll', () => {
  it('makes no request and writes nothing for an inactive repository', async () => {
    const fake = fakePrisma();
    const search = vi.fn();
    const base = automation();
    const outcome = await run(fake, search, {
      ...base,
      connection: { ...base.connection, isActive: false },
    });
    expect(outcome).toEqual({ reason: 'repository-inactive', status: 'skipped' });
    expect(search).not.toHaveBeenCalled();
    expect(fake.state()?.lastError).toBe('REPOSITORY_INACTIVE');
  });

  it('makes no request for a retired installation', async () => {
    const fake = fakePrisma();
    const search = vi.fn();
    const base = automation();
    const outcome = await run(fake, search, {
      ...base,
      connection: { ...base.connection, installation: { isActive: false } },
    });
    expect(outcome).toEqual({ reason: 'installation-retired', status: 'skipped' });
    expect(search).not.toHaveBeenCalled();
    expect(fake.state()?.lastError).toBe('REPOSITORY_INACTIVE');
  });

  it('makes no Jira request while the team’s kill switch is off, and asks with its team and org', async () => {
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? false : ['PAY']
    );
    const fake = fakePrisma();
    const search = vi.fn();
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ reason: 'switched-off', status: 'skipped' });
    expect(search).not.toHaveBeenCalled();
    expect(fake.state()?.lastError).toBe('SWITCHED_OFF');
    expect(settings.resolveSetting).toHaveBeenCalledWith('workflow.jiraPollAutomationsEnabled', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('makes no request while another replica holds the lease', async () => {
    const fake = fakePrisma({ leaseUntil: new Date(NOW.getTime() + 60_000) });
    const search = vi.fn();
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ reason: 'leased', status: 'skipped' });
    expect(search).not.toHaveBeenCalled();
  });

  it('takes over a lease that has expired', async () => {
    const fake = fakePrisma({ leaseUntil: new Date(NOW.getTime() - 1) });
    const search = vi.fn(async () => found(hit('PAY-1')));
    const outcome = await run(fake, search);
    expect(outcome.status).toBe('baselined');
  });
});

describe('wrapJqlInProjects: a trailing ORDER BY', () => {
  it('is dropped, because the poller needs no order and Jira refuses it inside parentheses', () => {
    expect(wrapJqlInProjects('status = Open ORDER BY created DESC', ['PAY'])).toBe(
      'project in ("PAY") AND (status = Open)'
    );
    expect(wrapJqlInProjects('status = Open  order   by  priority, created', ['PAY'])).toBe(
      'project in ("PAY") AND (status = Open)'
    );
  });

  it('is dropped when it names a quoted field, or follows a closing parenthesis directly', () => {
    expect(wrapJqlInProjects('status = Open ORDER BY "Story Points" DESC', ['PAY'])).toBe(
      'project in ("PAY") AND (status = Open)'
    );
    expect(wrapJqlInProjects("status = Open ORDER BY 'Story Points', created", ['PAY'])).toBe(
      'project in ("PAY") AND (status = Open)'
    );
    expect(wrapJqlInProjects('(a = 1)order by x', ['PAY'])).toBe(
      'project in ("PAY") AND ((a = 1))'
    );
    expect(wrapJqlInProjects('status = Open ORDER BY cf[10001] DESC', ['PAY'])).toBe(
      'project in ("PAY") AND (status = Open)'
    );
  });

  it('leaves the words inside a quoted string alone', () => {
    expect(wrapJqlInProjects('summary ~ "sort order by name"', ['PAY'])).toBe(
      'project in ("PAY") AND (summary ~ "sort order by name")'
    );
  });

  it('keeps only the project clause when the whole JQL was an ORDER BY', () => {
    expect(wrapJqlInProjects('ORDER BY created', ['PAY'])).toBe('project in ("PAY")');
  });
});

describe('hasBalancedParentheses', () => {
  it.each([
    ['status = Open', true],
    ['(a = 1 OR b = 2) AND c = 3', true],
    ['summary ~ "a ) b" AND (c = 1)', true],
    ["summary ~ 'a ( b'", true],
    ['summary ~ "say \\"hi\\" )"', true],
    ['x = 1) OR project = SECRET OR (x = 1', false],
    ['(a = 1', false],
    ['a = 1)', false],
    [')(', false],
  ])('%s -> %s', (jql, expected) => {
    expect(hasBalancedParentheses(jql)).toBe(expected);
  });
});

describe('pollAutomation: the lease', () => {
  it('treats a lease that ends exactly now as still held', async () => {
    const fake = fakePrisma({ leaseUntil: NOW });
    const search = vi.fn();
    expect(await run(fake, search)).toEqual({ reason: 'leased', status: 'skipped' });
    expect(search).not.toHaveBeenCalled();
  });

  it('does not erase a lease another replica took while this poll was running', async () => {
    const fake = fakePrisma();
    const theirs = new Date(NOW.getTime() + 600_000);
    const search = vi.fn(async () => {
      fake.takeOver(theirs);
      return found(hit('PAY-1'));
    });
    await run(fake, search);
    expect(fake.state()?.leaseUntil).toEqual(theirs);
  });

  it('lets the poll’s own failure through when releasing the lease fails too', async () => {
    const fake = fakePrisma();
    fake.prisma.automationSeenIssue.createMany.mockRejectedValueOnce(new Error('db down'));
    const release = new Error('release failed');
    fake.prisma.automationPollState.updateMany
      .mockImplementationOnce(
        fake.prisma.automationPollState.updateMany.getMockImplementation() as never
      )
      .mockRejectedValueOnce(release);
    const search = vi.fn(async () => found(hit('PAY-1')));
    await expect(run(fake, search)).rejects.toThrow('db down');
  });

  it('reports a failed release when the poll itself went well', async () => {
    const fake = fakePrisma();
    const release = new Error('release failed');
    fake.prisma.automationPollState.updateMany
      .mockImplementationOnce(
        fake.prisma.automationPollState.updateMany.getMockImplementation() as never
      )
      .mockRejectedValueOnce(release);
    const search = vi.fn(async () => found(hit('PAY-1')));
    await expect(run(fake, search)).rejects.toBe(release);
  });
});

describe('pollAutomation: what a baseline is bound to', () => {
  it('takes a new baseline, starting nothing, when a project is added to the allowlist', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: NARROWED,
    });
    fake.seen.add('pay-1');
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAY', 'OPS', 'HR2']
    );
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    // HR2-7 matched all along, but HR2 was not allowed: it must be recorded, not started.
    const search = vi.fn(async () => found(hit('PAY-1'), hit('HR2-7')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ recorded: 2, status: 'baselined' });
    expect(decide).not.toHaveBeenCalled();
    expect(fake.state()?.baselineJql).toBe('project in ("HR2", "OPS", "PAY") AND (status = Open)');
  });

  it('clears the baseline while the allowlist is empty, so restoring it starts nothing for what appeared meanwhile', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: NARROWED,
    });
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : []
    );
    const locked = await run(fake, vi.fn());
    expect(locked).toEqual({ code: 'NO_ALLOWED_PROJECTS', status: 'error' });
    expect(fake.state()?.baselinedAt).toBeNull();
    expect(fake.state()?.lastError).toBe('NO_ALLOWED_PROJECTS');
    // The same list is restored: issues created during the lockout are recorded, not started.
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAY', 'OPS']
    );
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const resumed = await run(
      fake,
      vi.fn(async () => found(hit('PAY-1'))),
      automation(),
      {
        decide,
      }
    );
    expect(resumed.status).toBe('baselined');
    expect(decide).not.toHaveBeenCalled();
  });

  it('keeps the baseline when only the order of the allowlist differs', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: NARROWED,
    });
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : ['pay', 'ops']
    );
    const search = vi.fn(async () => found());
    expect((await run(fake, search)).status).toBe('polled');
  });

  it('keeps the baseline when only a trailing ORDER BY of the JQL differs', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: NARROWED,
    });
    const search = vi.fn(async () => found());
    const a = automation({ filters: { jql: 'status = Open ORDER BY created DESC' } });
    expect((await run(fake, search, a)).status).toBe('polled');
  });

  it.each([
    ['the team’s polling switch is off', 'switched-off'],
    ['the repository is inactive', 'repository-inactive'],
  ])(
    'clears the baseline while %s, so polling resumes from now and never with a backlog',
    async (_label, reason) => {
      const fake = fakePrisma({
        baselinedAt: new Date('2026-10-01T00:00:00Z'),
        baselineJql: NARROWED,
      });
      const base = automation();
      if (reason === 'switched-off') {
        settings.resolveSetting.mockImplementation(async (key: string) =>
          key === 'workflow.jiraPollAutomationsEnabled' ? false : ['PAY']
        );
      }
      const a =
        reason === 'repository-inactive'
          ? { ...base, connection: { ...base.connection, isActive: false } }
          : base;
      await run(fake, vi.fn(), a);
      expect(fake.state()?.baselinedAt).toBeNull();
      // Switched back on, the next poll baselines and starts nothing.
      settings.resolveSetting.mockImplementation(async (key: string) =>
        key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAY', 'OPS']
      );
      const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
      const resumed = await run(
        fake,
        vi.fn(async () => found(hit('PAY-1'))),
        automation(),
        { decide }
      );
      expect(resumed.status).toBe('baselined');
      expect(decide).not.toHaveBeenCalled();
    }
  );
});

describe('pollAutomation: the baseline', () => {
  it('stores every match as seen, lower-cased, starts nothing and releases the lease', async () => {
    const fake = fakePrisma();
    const search = vi.fn(async () => found(hit('PAY-1'), hit('OPS-22')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ recorded: 2, status: 'baselined' });
    expect([...fake.seen].sort()).toEqual(['ops-22', 'pay-1']);
    expect(search).toHaveBeenCalledWith(NARROWED, {
      maxResults: JIRA_POLL_MAX_MATCHES,
    });
    expect(fake.state()).toMatchObject({
      baselinedAt: NOW,
      baselineJql: NARROWED,
      lastError: null,
      lastPolledAt: NOW,
      leaseUntil: null,
    });
  });

  it('caps a poll at 1000 matches', () => {
    expect(JIRA_POLL_MAX_MATCHES).toBe(1000);
  });

  it('baselines again, starts nothing, and records the new JQL when the JQL changed since the baseline', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: 'status = "In Progress"',
    });
    fake.seen.add('pay-1');
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    // PAY-9 matches the new JQL and was never seen: it must be recorded, not started.
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-9')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ recorded: 2, status: 'baselined' });
    expect(decide).not.toHaveBeenCalled();
    expect([...fake.seen].sort()).toEqual(['pay-1', 'pay-9']);
    expect(fake.state()?.baselineJql).toBe(NARROWED);
  });

  it('does not baseline again once baselined', async () => {
    const fake = fakePrisma({
      baselinedAt: new Date('2026-10-01T00:00:00Z'),
      baselineJql: NARROWED,
    });
    fake.seen.add('pay-1');
    const search = vi.fn(async () => found(hit('PAY-1')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ pending: 0, started: 0, status: 'polled', suppressed: 0 });
    expect(fake.prisma.automationSeenIssue.createMany).not.toHaveBeenCalled();
    expect(fake.state()?.lastPolledAt).toEqual(NOW);
    expect(fake.state()?.leaseUntil).toBeNull();
  });
});

describe('pollAutomation: the project allowlist', () => {
  it('ignores a match outside the allowlist whatever the JQL said', async () => {
    const fake = fakePrisma();
    const search = vi.fn(async () => found(hit('PAY-1'), hit('SECRET-9', 'SECRET')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ recorded: 1, status: 'baselined' });
    expect([...fake.seen]).toEqual(['pay-1']);
  });

  it('compares project keys without case, on both sides', async () => {
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : ['pay']
    );
    const fake = fakePrisma();
    const search = vi.fn(async () => found(hit('PAY-1', 'PAY'), hit('pay-2', 'Pay')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ recorded: 2, status: 'baselined' });
  });

  it('records NO_ALLOWED_PROJECTS and makes no request when the allowlist is empty', async () => {
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : []
    );
    const fake = fakePrisma();
    const search = vi.fn();
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ code: 'NO_ALLOWED_PROJECTS', status: 'error' });
    expect(search).not.toHaveBeenCalled();
    expect(fake.state()).toMatchObject({
      baselinedAt: null,
      lastError: 'NO_ALLOWED_PROJECTS',
      leaseUntil: null,
    });
  });
});

describe('pollAutomation: new issues', () => {
  const baselined = () =>
    fakePrisma({ baselinedAt: new Date('2026-10-01T00:00:00Z'), baselineJql: NARROWED });

  it('decides once for each issue it has not seen, and marks it seen afterwards', async () => {
    const fake = baselined();
    fake.seen.add('pay-1');
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2'), hit('PAY-3')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ pending: 0, started: 2, status: 'polled', suppressed: 0 });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls.map(([facts]) => facts.issueKey)).toEqual(['PAY-2', 'PAY-3']);
    expect([...fake.seen].sort()).toEqual(['pay-1', 'pay-2', 'pay-3']);
  });

  it('decides nothing for an issue it has already seen, so a later poll starts no second run', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-1')));
    await run(fake, search, automation(), { decide });
    await run(fake, search, automation(), { decide });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('never decides during the baseline poll', async () => {
    const fake = fakePrisma();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-1')));
    expect((await run(fake, search, automation(), { decide })).status).toBe('baselined');
    expect(decide).not.toHaveBeenCalled();
  });

  it('builds the facts from the issue, bounded, with a link that comes from the configured Jira', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const fetchIssue = vi.fn(async (key: string) =>
      issueFor(key, { description: 'd'.repeat(5000), title: 't'.repeat(400) })
    );
    const search = vi.fn(async () => found(hit('PAY-7', 'PAY')));
    await run(fake, search, automation(), { decide, fetchIssue });
    const facts = decide.mock.calls[0]?.[0];
    expect(facts).toEqual({
      description: 'd'.repeat(4000),
      issueKey: 'PAY-7',
      projectKey: 'PAY',
      summary: 't'.repeat(256),
      url: 'https://acme.atlassian.net/browse/PAY-7',
    });
  });

  it('takes them in key order: by project, then issue number', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-10'), hit('PAY-2'), hit('PAY-33')));
    await run(fake, search, automation(), { decide });
    expect(decide.mock.calls.map(([facts]) => facts.issueKey)).toEqual([
      'PAY-2',
      'PAY-10',
      'PAY-33',
    ]);
  });

  it('handles at most 50 a poll and leaves the rest unseen for the next one', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const all = Array.from({ length: 60 }, (_, i) => hit(`PAY-${i + 1}`));
    const search = vi.fn(async () => found(...all));
    const outcome = await run(fake, search, automation(), { decide });
    expect(decide).toHaveBeenCalledTimes(50);
    expect(outcome).toEqual({ pending: 10, started: 50, status: 'polled', suppressed: 0 });
    expect(fake.seen.has('pay-51')).toBe(false);
    expect(fake.seen.has('pay-50')).toBe(true);
  });

  it.each([
    'SUPPRESSED_DAILY_CAP',
    'SUPPRESSED_BUDGET',
    'SUPPRESSED_IN_FLIGHT',
    'SUPPRESSED_PRECONDITION',
  ] as const)('marks an issue seen when the engine suppresses it (%s)', async (outcomeName) => {
    const fake = baselined();
    const decide = vi.fn(
      async (): Promise<AutomationResult> => ({
        automationId: 'auto-1',
        outcome: outcomeName,
      })
    );
    const search = vi.fn(async () => found(hit('PAY-1')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ pending: 0, started: 0, status: 'polled', suppressed: 1 });
    expect(fake.seen.has('pay-1')).toBe(true);
  });

  it('marks an issue seen when the engine says it already decided it', async () => {
    const fake = baselined();
    const decide = vi.fn(async (): Promise<AutomationResult> => ({ duplicate: true }));
    const search = vi.fn(async () => found(hit('PAY-1')));
    await run(fake, search, automation(), { decide });
    expect(fake.seen.has('pay-1')).toBe(true);
  });

  it('leaves an issue unseen and stops the batch when its start failed', async () => {
    const fake = baselined();
    const decide = vi.fn(
      async (): Promise<AutomationResult> => ({
        automationId: 'auto-1',
        outcome: 'FAILED_TO_START',
        reason: 'no active version',
      })
    );
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ code: 'START_FAILED', status: 'error' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(fake.seen.size).toBe(0);
    expect(fake.state()?.lastError).toBe('START_FAILED');
  });

  it('does the same when starting the workflow throws', async () => {
    const fake = baselined();
    const decide = vi.fn(async () => {
      throw new AutomationStartError('temporal down');
    });
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ code: 'START_FAILED', status: 'error' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(fake.seen.size).toBe(0);
  });

  it('lets an unexpected failure through, and keeps what it had already decided', async () => {
    const fake = baselined();
    const decide = vi
      .fn()
      .mockResolvedValueOnce(started())
      .mockRejectedValueOnce(new Error('db down'));
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2')));
    await expect(run(fake, search, automation(), { decide })).rejects.toThrow('db down');
    expect([...fake.seen]).toEqual(['pay-1']);
    expect(fake.state()?.leaseUntil).toBeNull();
  });

  it('stops with a visible error and marks nothing when the engine ignores the occurrence', async () => {
    const fake = baselined();
    const decide = vi.fn(
      async (_facts: JiraFilterFacts): Promise<AutomationResult> => ({
        ignored: true,
        reason: 'Jira filter automations are switched off',
      })
    );
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ code: 'START_FAILED', status: 'error' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(fake.seen.size).toBe(0);
    expect(fake.state()?.lastError).toBe('START_FAILED');
  });

  it('stops with TRACKER_UNAVAILABLE when an issue cannot be read, keeping what it already started', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const fetchIssue = vi.fn(async (key: string) => (key === 'PAY-2' ? null : issueFor(key)));
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2'), hit('PAY-3')));
    const outcome = await run(fake, search, automation(), { decide, fetchIssue });
    expect(outcome).toEqual({ code: 'TRACKER_UNAVAILABLE', status: 'error' });
    expect(decide).toHaveBeenCalledTimes(1);
    expect([...fake.seen]).toEqual(['pay-1']);
    expect(fake.state()?.lastError).toBe('TRACKER_UNAVAILABLE');
    expect(fake.state()?.leaseUntil).toBeNull();
  });

  it('marks seen, and goes on, when the issue it read is not the one the search approved', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    // PAY-1 was moved to a project that is not allowed between the search and the read.
    const fetchIssue = vi.fn(async (key: string) =>
      key === 'PAY-1' ? issueFor('SECRET-5') : issueFor(key)
    );
    const search = vi.fn(async () => found(hit('PAY-1'), hit('PAY-2')));
    const outcome = await run(fake, search, automation(), { decide, fetchIssue });
    expect(outcome).toEqual({ pending: 0, started: 1, status: 'polled', suppressed: 0 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0].issueKey).toBe('PAY-2');
    // A moved issue has a new key, so the old one is done with: it must not hold a place in the
    // window of 50 on every poll.
    expect([...fake.seen].sort()).toEqual(['pay-1', 'pay-2']);
  });

  it('does the same when reading an issue throws, without Jira’s text', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const fetchIssue = vi.fn(async () => {
      throw new Error('503 from internal-host with token abc123');
    });
    const search = vi.fn(async () => found(hit('PAY-1')));
    const outcome = await run(fake, search, automation(), { decide, fetchIssue });
    expect(outcome).toEqual({ code: 'TRACKER_UNAVAILABLE', status: 'error' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('marks seen an issue whose facts can never be valid, so it cannot block the rest', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-12345678901'), hit('PAY-2')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(outcome).toEqual({ pending: 0, started: 1, status: 'polled', suppressed: 0 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0].issueKey).toBe('PAY-2');
    expect([...fake.seen].sort()).toEqual(['pay-12345678901', 'pay-2']);
  });

  it('decides an issue once even when the search returns its key in two spellings', async () => {
    const fake = baselined();
    const decide = vi.fn(async (_facts: JiraFilterFacts) => started());
    const search = vi.fn(async () => found(hit('PAY-1'), hit('pay-1')));
    const outcome = await run(fake, search, automation(), { decide });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ pending: 0, started: 1, status: 'polled', suppressed: 0 });
  });
});

describe('pollAutomation: keeping the allowlist wrapper meaningful', () => {
  it('refuses JQL that steps outside the wrapper with unbalanced parentheses, asking Jira nothing', async () => {
    const fake = fakePrisma();
    const search = vi.fn();
    const outcome = await run(
      fake,
      search,
      automation({ filters: { jql: 'x = 1) OR project = SECRET OR (x = 1' } })
    );
    expect(outcome).toEqual({ code: 'INVALID_FILTERS', status: 'error' });
    expect(search).not.toHaveBeenCalled();
  });

  it('does not let a non-ASCII project key fold onto an allowed one', async () => {
    settings.resolveSetting.mockImplementation(async (key: string) =>
      key === 'workflow.jiraPollAutomationsEnabled' ? true : ['PAS']
    );
    const fake = fakePrisma();
    const search = vi.fn(async () => found(hit('PAS-1', 'PAſ'), hit('PAS-2', 'PAS')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ recorded: 1, status: 'baselined' });
    expect([...fake.seen]).toEqual(['pas-2']);
  });
});

describe('pollAutomation: failures are fixed codes and leave nothing half-done', () => {
  it('records FILTER_TOO_BROAD and baselines nothing when the search is cut', async () => {
    const fake = fakePrisma();
    const search = vi.fn(async () => ({ issues: [hit('PAY-1')], truncated: true }));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ code: 'FILTER_TOO_BROAD', status: 'error' });
    expect(fake.prisma.automationSeenIssue.createMany).not.toHaveBeenCalled();
    expect(fake.state()).toMatchObject({
      baselinedAt: null,
      lastError: 'FILTER_TOO_BROAD',
      leaseUntil: null,
    });
  });

  it('records JQL_REJECTED when Jira answers 400, without Jira’s text', async () => {
    const fake = fakePrisma();
    const search = vi.fn(async () => {
      throw new AtlassianError(400, 'server', 'Atlassian request failed: 400 secret-detail');
    });
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ code: 'JQL_REJECTED', status: 'error' });
    expect(fake.state()?.lastError).toBe('JQL_REJECTED');
    expect(fake.state()?.leaseUntil).toBeNull();
  });

  it.each([
    ['an auth failure', new AtlassianError(401, 'auth', 'Atlassian auth failed: 401')],
    ['a server error', new AtlassianError(503, 'server', 'Atlassian server error: 503')],
    ['a network error', new AtlassianError(0, 'network', 'ECONNREFUSED internal-host')],
    ['an unexpected error', new Error('boom with a token abc123')],
  ])('records TRACKER_UNAVAILABLE for %s', async (_name, error) => {
    const fake = fakePrisma();
    const search = vi.fn(async () => {
      throw error;
    });
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ code: 'TRACKER_UNAVAILABLE', status: 'error' });
    expect(fake.state()?.lastError).toBe('TRACKER_UNAVAILABLE');
    expect(fake.state()?.leaseUntil).toBeNull();
  });

  it('records INVALID_FILTERS and makes no request when the stored filters do not parse', async () => {
    const fake = fakePrisma();
    const search = vi.fn();
    const outcome = await run(fake, search, automation({ filters: { jql: '' } }));
    expect(outcome).toEqual({ code: 'INVALID_FILTERS', status: 'error' });
    expect(search).not.toHaveBeenCalled();
    expect(fake.state()?.lastError).toBe('INVALID_FILTERS');
  });

  it('releases the lease and lets a database failure through, not blaming Jira for it', async () => {
    const fake = fakePrisma();
    fake.prisma.automationSeenIssue.createMany.mockRejectedValueOnce(new Error('db down'));
    const search = vi.fn(async () => found(hit('PAY-1')));
    await expect(run(fake, search)).rejects.toThrow('db down');
    expect(fake.state()?.leaseUntil).toBeNull();
    expect(fake.state()?.lastError).toBeNull();
    expect(fake.state()?.baselinedAt).toBeNull();
  });

  it('clears an earlier error after a good poll', async () => {
    const fake = fakePrisma({ lastError: 'TRACKER_UNAVAILABLE' });
    const search = vi.fn(async () => found(hit('PAY-1')));
    await run(fake, search);
    expect(fake.state()?.lastError).toBeNull();
  });
});

describe('connectionOwnerKey', () => {
  const instance = 'https://github.com';
  it('is the repository on its host, lower-cased, like the webhook path writes it', () => {
    expect(
      connectionOwnerKey({ githubUrl: null, organizationName: 'Acme', repoName: 'API' }, instance)
    ).toBe('github.com/acme/api');
  });

  it('uses the connection’s own host when it has one, port included', () => {
    expect(
      connectionOwnerKey(
        { githubUrl: 'https://ghe.example.com:8443', organizationName: 'acme', repoName: 'api' },
        instance
      )
    ).toBe('ghe.example.com:8443/acme/api');
  });

  it('is null for a connection that names no repository, or a host that does not parse', () => {
    expect(
      connectionOwnerKey({ githubUrl: null, organizationName: null, repoName: 'api' }, instance)
    ).toBeNull();
    expect(
      connectionOwnerKey({ githubUrl: null, organizationName: 'acme', repoName: null }, instance)
    ).toBeNull();
    expect(
      connectionOwnerKey(
        { githubUrl: 'not a url', organizationName: 'acme', repoName: 'api' },
        instance
      )
    ).toBeNull();
  });
});
