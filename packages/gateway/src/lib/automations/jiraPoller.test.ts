import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import type { IssueTrackerProvider } from '@auto-swe/shared/lib/integrations/issueTracker';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => settings);

import {
  hasBalancedParentheses,
  JIRA_POLL_MAX_MATCHES,
  type PollableAutomation,
  pollAutomation,
  wrapJqlInProjects,
} from './jiraPoller.js';

type SearchIssuesResult = Awaited<ReturnType<IssueTrackerProvider['searchIssues']>>;

const NOW = new Date('2026-10-27T12:00:00Z');

interface StateRow {
  automationId: string;
  baselinedAt: Date | null;
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
          // A claim takes a free or expired lease; a release only the lease its caller holds.
          const matches = where.OR
            ? state.leaseUntil === null || state.leaseUntil < where.OR[1].leaseUntil.lt
            : state.leaseUntil?.getTime() === where.leaseUntil?.getTime();
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

const run = (
  fake: ReturnType<typeof fakePrisma>,
  searchIssues: ReturnType<typeof vi.fn>,
  a: PollableAutomation = automation()
) =>
  pollAutomation({ now: NOW, prisma: fake.prisma as never, tracker: { searchIssues } as never }, a);

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
    expect(fake.prisma.automationPollState.createMany).not.toHaveBeenCalled();
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
    expect(fake.prisma.automationPollState.createMany).not.toHaveBeenCalled();
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

describe('pollAutomation: the baseline', () => {
  it('stores every match as seen, lower-cased, starts nothing and releases the lease', async () => {
    const fake = fakePrisma();
    const search = vi.fn(async () => found(hit('PAY-1'), hit('OPS-22')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ recorded: 2, status: 'baselined' });
    expect([...fake.seen].sort()).toEqual(['ops-22', 'pay-1']);
    expect(search).toHaveBeenCalledWith('project in ("PAY", "OPS") AND (status = Open)', {
      maxResults: JIRA_POLL_MAX_MATCHES,
    });
    expect(fake.state()).toMatchObject({
      baselinedAt: NOW,
      lastError: null,
      lastPolledAt: NOW,
      leaseUntil: null,
    });
  });

  it('caps a poll at 1000 matches', () => {
    expect(JIRA_POLL_MAX_MATCHES).toBe(1000);
  });

  it('does not baseline again once baselined', async () => {
    const fake = fakePrisma({ baselinedAt: new Date('2026-10-01T00:00:00Z') });
    const search = vi.fn(async () => found(hit('PAY-1')));
    const outcome = await run(fake, search);
    expect(outcome).toEqual({ status: 'polled' });
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
