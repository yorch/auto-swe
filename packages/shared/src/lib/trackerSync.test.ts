import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  findConnections: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  findMemberships: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  findRunInput: vi.fn(),
  findWorkflowRun: vi.fn(),
  overrideAt: vi.fn((_key: string, _scope: string): unknown => undefined),
  resolveSetting: vi.fn(),
  syncOnEvent: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
}));

vi.mock('../db.js', () => ({
  prisma: {
    connection: { findMany: (...args: unknown[]) => mocks.findConnections(...args) },
    runInput: { findUnique: (...args: unknown[]) => mocks.findRunInput(...args) },
    teamMembership: { findMany: (...args: unknown[]) => mocks.findMemberships(...args) },
    workflowRun: { findFirst: (...args: unknown[]) => mocks.findWorkflowRun(...args) },
  },
}));
vi.mock('../config/index.js', () => ({
  resolveEffectiveSettings: async () => ({
    overrideAt: (key: string, scope: string) => mocks.overrideAt(key, scope),
    settings: [],
  }),
  resolveSetting: (...args: unknown[]) => mocks.resolveSetting(...args),
}));
vi.mock('./systemConfig.js', () => ({
  resolveGitHubBaseUrl: async () => 'https://github.com',
}));
vi.mock('./integrations/registry.js', () => ({
  createIssueTrackerProvider: (...args: unknown[]) => mocks.createProvider(...args),
}));

import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import {
  isGitHubTicketInScope,
  isTrackerReadInScope,
  isTrackerWriteInScope,
  loadRunLaunchContexts,
  loadUserTrackerTeams,
  repoTrackerScope,
  resolveTrackerIssueRepos,
  runTrackerScope,
  syncTrackerOnEvent,
  TRACKER_SYNC_FAILED,
  TRACKER_SYNC_NO_REPOSITORY,
  TRACKER_SYNC_OUT_OF_SCOPE,
  TRACKER_SYNC_PROJECT_OUT_OF_SCOPE,
  type TrackerRepoScope,
  type TrackerScopeRepo,
} from './trackerSync.js';

const DOTCOM = 'https://github.com';
const repo = (overrides: Partial<TrackerScopeRepo> = {}): TrackerScopeRepo => ({
  githubApiUrl: null,
  githubUrl: null,
  organizationName: 'Acme',
  repoName: 'Web',
  ...overrides,
});
const scope = (...repos: TrackerScopeRepo[]): TrackerRepoScope => ({
  allowedProjectKeys: [],
  instanceBaseUrl: DOTCOM,
  repos,
});

beforeEach(() => {
  mocks.resolveSetting.mockReset();
  mocks.resolveSetting.mockResolvedValue([]);
  mocks.overrideAt.mockReset();
  mocks.overrideAt.mockReturnValue(undefined);
  mocks.findRunInput.mockReset();
  mocks.findWorkflowRun.mockReset();
  mocks.findMemberships.mockReset();
  mocks.findMemberships.mockResolvedValue([]);
});

describe('isGitHubTicketInScope', () => {
  it('accepts an issue in a repository of the scope, ignoring case', () => {
    expect(isGitHubTicketInScope('acme/web#1', null, scope(repo()))).toBe(true);
    expect(isGitHubTicketInScope('ACME/WEB#1', null, scope(repo()))).toBe(true);
  });

  it('refuses another repository, another owner and a bare number', () => {
    expect(isGitHubTicketInScope('attacker/web#1', null, scope(repo()))).toBe(false);
    expect(isGitHubTicketInScope('acme/other#1', null, scope(repo()))).toBe(false);
    expect(isGitHubTicketInScope('#1', null, scope(repo()))).toBe(false);
    expect(isGitHubTicketInScope('acme/web#1', null, scope())).toBe(false);
  });

  it('treats a repository with no host as the instance host, github.com by default', () => {
    const onDotcom = scope(repo());
    expect(isGitHubTicketInScope('acme/web#1', 'https://api.github.com', onDotcom)).toBe(true);
    const onGhe: TrackerRepoScope = {
      allowedProjectKeys: [],
      instanceBaseUrl: 'https://ghe.corp',
      repos: [repo()],
    };
    expect(isGitHubTicketInScope('acme/web#1', null, onGhe)).toBe(false);
    expect(isGitHubTicketInScope('acme/web#1', 'https://ghe.corp/api/v3', onGhe)).toBe(true);
  });

  it('refuses a GitHub Enterprise repository when the tracker writes to github.com', () => {
    const ghe = scope(
      repo({ githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://ghe.corp' })
    );
    expect(isGitHubTicketInScope('acme/web#1', null, ghe)).toBe(false);
    expect(isGitHubTicketInScope('acme/web#1', 'https://api.github.com', ghe)).toBe(false);
  });

  it('refuses a github.com repository when the tracker writes to GitHub Enterprise', () => {
    const dotcom = scope(repo({ githubApiUrl: 'https://api.github.com', githubUrl: DOTCOM }));
    expect(isGitHubTicketInScope('acme/web#1', 'https://ghe.corp/api/v3', dotcom)).toBe(false);
  });

  it('matches a GitHub Enterprise repository on the tracker host, whatever scheme and port', () => {
    const ghe = scope(
      repo({ githubApiUrl: 'http://GHE.corp:80/api/v3', githubUrl: 'https://ghe.corp' })
    );
    expect(isGitHubTicketInScope('acme/web#1', 'https://ghe.corp:443/api/v3/', ghe)).toBe(true);
  });

  it('folds a hosted GitHub API host into its web host', () => {
    const cloud = scope(repo({ githubUrl: 'https://acme.ghe.com' }));
    expect(isGitHubTicketInScope('acme/web#1', 'https://api.acme.ghe.com', cloud)).toBe(true);
  });

  it('refuses a repository whose web and API hosts disagree', () => {
    const half = scope(
      repo({ githubApiUrl: 'https://api.github.com', githubUrl: 'https://ghe.corp' })
    );
    expect(isGitHubTicketInScope('acme/web#1', null, half)).toBe(false);
  });

  it('fails closed on a host that does not parse', () => {
    expect(isGitHubTicketInScope('acme/web#1', '', scope(repo()))).toBe(false);
    expect(isGitHubTicketInScope('acme/web#1', 'not a url', scope(repo()))).toBe(false);
    const bare = scope(repo({ githubUrl: 'ghe.corp' }));
    expect(isGitHubTicketInScope('acme/web#1', null, bare)).toBe(false);
    const ftp = scope(repo({ githubUrl: 'ftp://github.com' }));
    expect(isGitHubTicketInScope('acme/web#1', null, ftp)).toBe(false);
  });
});

describe('isGitHubTicketInScope with a default repository', () => {
  const web = { owner: 'acme', repo: 'web' };

  it('resolves a bare number against the default repository and checks that', () => {
    expect(isGitHubTicketInScope('#7', null, scope(repo()), web)).toBe(true);
    expect(isGitHubTicketInScope('7', null, scope(repo()), web)).toBe(true);
    expect(isGitHubTicketInScope('#7', null, scope(), web)).toBe(false);
    const ghe = scope(repo({ githubUrl: 'https://ghe.corp' }));
    expect(isGitHubTicketInScope('#7', null, ghe, web)).toBe(false);
  });

  it('does not let the default repository widen an id that names its own repository', () => {
    expect(isGitHubTicketInScope('attacker/web#1', null, scope(repo()), web)).toBe(false);
  });
});

describe('isGitHubTicketInScope with operator-listed repositories', () => {
  const withExtra = (extraRepos: string[], ...repos: TrackerScopeRepo[]): TrackerRepoScope => ({
    allowedProjectKeys: [],
    extraRepos,
    instanceBaseUrl: DOTCOM,
    repos,
  });

  it('allows a named ticket in a listed repository, case-insensitively', () => {
    const listed = withExtra(['Acme/Issues'], repo());
    expect(isGitHubTicketInScope('acme/issues#5', null, listed)).toBe(true);
    expect(isGitHubTicketInScope('ACME/ISSUES#5', null, listed)).toBe(true);
  });

  it('allows a listed repository when the run targets none', () => {
    expect(isGitHubTicketInScope('acme/issues#5', null, withExtra(['acme/issues']))).toBe(true);
  });

  it('refuses a repository that is neither a run repository nor listed', () => {
    const listed = withExtra(['acme/issues'], repo());
    expect(isGitHubTicketInScope('acme/other#5', null, listed)).toBe(false);
    expect(isGitHubTicketInScope('acme/issues-2#5', null, listed)).toBe(false);
    expect(isGitHubTicketInScope('attacker/issues#5', null, listed)).toBe(false);
  });

  it('never resolves a bare number against the list', () => {
    const listed = withExtra(['acme/issues']);
    const issues = { owner: 'acme', repo: 'issues' };
    expect(isGitHubTicketInScope('#5', null, listed, issues)).toBe(false);
    expect(isGitHubTicketInScope('5', null, listed, issues)).toBe(false);
    expect(isGitHubTicketInScope('5', null, withExtra(['acme/issues'], repo()), issues)).toBe(
      false
    );
  });

  it('applies no host comparison to a listed repository, but still needs a valid tracker URL', () => {
    const listed = withExtra(['acme/issues'], repo({ githubUrl: 'https://other.example' }));
    expect(isGitHubTicketInScope('acme/issues#5', null, listed)).toBe(true);
    expect(isGitHubTicketInScope('acme/issues#5', 'https://ghe.corp/api/v3', listed)).toBe(true);
    expect(isGitHubTicketInScope('acme/issues#5', 'not a url', listed)).toBe(false);
  });

  it('keeps the host rule for a run repository', () => {
    const listed = withExtra(['acme/issues'], repo());
    expect(isGitHubTicketInScope('acme/web#1', 'https://ghe.corp/api/v3', listed)).toBe(false);
  });

  it('treats a missing or empty list as no list', () => {
    expect(isGitHubTicketInScope('acme/issues#5', null, scope(repo()))).toBe(false);
    expect(isGitHubTicketInScope('acme/issues#5', null, withExtra([], repo()))).toBe(false);
  });
});

describe('resolveTrackerIssueRepos', () => {
  it('returns the setting resolved at the given scope', async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    expect(await resolveTrackerIssueRepos({ orgId: 'o', teamId: 't' })).toEqual(['acme/issues']);
    expect(mocks.resolveSetting).toHaveBeenCalledWith('github.trackerIssueRepositories', {
      orgId: 'o',
      teamId: 't',
    });
  });

  it('fails closed: an error, or a value that is not a list, is an empty list', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    expect(await resolveTrackerIssueRepos({})).toEqual([]);
    mocks.resolveSetting.mockResolvedValue('acme/issues');
    expect(await resolveTrackerIssueRepos({})).toEqual([]);
    mocks.resolveSetting.mockResolvedValue(['acme/issues', 7, null]);
    expect(await resolveTrackerIssueRepos({})).toEqual(['acme/issues']);
  });
});

describe('repoTrackerScope', () => {
  it('pairs the repositories with the instance host and an empty list by default', async () => {
    const repos = [repo()];
    expect(await repoTrackerScope(repos)).toEqual({
      allowedProjectKeys: [],
      extraRepos: [],
      instanceBaseUrl: DOTCOM,
      repos,
    });
  });

  it("resolves the list at the repository's team and organization", async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    const repos = [repo({ team: { orgId: 'org-1' }, teamId: 'team-1' })];
    expect((await repoTrackerScope(repos)).extraRepos).toEqual(['acme/issues']);
    expect(mocks.resolveSetting).toHaveBeenCalledWith('github.trackerIssueRepositories', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it("lists the union of every repository's own scope", async () => {
    mocks.resolveSetting.mockImplementation(async (_key: string, ctx: { teamId?: string }) =>
      ctx.teamId === 'team-2' ? ['acme/b', 'acme/shared'] : ['acme/a', 'acme/shared']
    );
    const repos = [
      repo({ teamId: 'team-1' }),
      repo({ repoName: 'Api', team: { orgId: 'org-2' }, teamId: 'team-2' }),
    ];
    expect((await repoTrackerScope(repos)).extraRepos).toEqual(['acme/a', 'acme/shared', 'acme/b']);
  });

  it('does not throw, and lists nothing, when the setting cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    expect((await repoTrackerScope([repo({ teamId: 'team-1' })])).extraRepos).toEqual([]);
  });

  it('lists nothing, and reads no setting, for a repository with no owning team', async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    expect((await repoTrackerScope([repo()])).extraRepos).toEqual([]);
    expect(mocks.resolveSetting).not.toHaveBeenCalledWith(
      'github.trackerIssueRepositories',
      expect.anything()
    );
  });
});

describe('allowedProjectKeys in repoTrackerScope', () => {
  const byTeam =
    (lists: Record<string, string[]>) => async (key: string, ctx: { teamId?: string }) =>
      key === 'tracker.allowedProjectKeys' ? (lists[ctx.teamId ?? ''] ?? []) : [];

  it('is empty (unrestricted) when every context lists nothing', async () => {
    expect((await repoTrackerScope([repo({ teamId: 't1' })])).allowedProjectKeys).toEqual([]);
  });

  it("resolves at the repository's team and organization", async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ t1: ['PAY'] }));
    const repos = [repo({ team: { orgId: 'o1' }, teamId: 't1' })];
    expect((await repoTrackerScope(repos)).allowedProjectKeys).toEqual(['PAY']);
    expect(mocks.resolveSetting).toHaveBeenCalledWith('tracker.allowedProjectKeys', {
      orgId: 'o1',
      teamId: 't1',
    });
  });

  it('unions the non-empty lists; an empty list does not make the request unrestricted', async () => {
    mocks.resolveSetting.mockImplementation(
      byTeam({ t1: ['PAY', 'ENG'], t2: ['eng', 'HR'], t3: [] })
    );
    const repos = [repo({ teamId: 't1' }), repo({ teamId: 't2' }), repo({ teamId: 't3' })];
    const keys = (await repoTrackerScope(repos)).allowedProjectKeys.map((k) => k.toLowerCase());
    expect(keys.sort()).toEqual(['eng', 'hr', 'pay']);
  });

  it('resolves at GLOBAL for a connection-less request or a repository with no team', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ '': ['PAY'] }));
    expect((await repoTrackerScope([])).allowedProjectKeys).toEqual(['PAY']);
    expect((await repoTrackerScope([repo()])).allowedProjectKeys).toEqual(['PAY']);
  });

  it('flags the scope unreadable, rather than empty, when the setting cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    const loaded = await repoTrackerScope([repo({ teamId: 't1' })]);
    expect(loaded.allowedProjectKeys).toEqual([]);
    expect(loaded.projectKeysUnreadable).toBe(true);
    expect(await isTrackerReadInScope({ provider: 'jira' }, 'PAY-1', async () => loaded)).toBe(
      false
    );
  });
  it("resolves a repository-less request at the launching template's team and organization", async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ '': ['GLOBALKEY'], tpl: ['PAY'] }));
    const loaded = await repoTrackerScope([], { orgId: 'o9', teamId: 'tpl' });
    expect(loaded.allowedProjectKeys).toEqual(['PAY']);
    expect(mocks.resolveSetting).toHaveBeenCalledWith('tracker.allowedProjectKeys', {
      orgId: 'o9',
      teamId: 'tpl',
    });
    const jira = { provider: 'jira' };
    expect(await isTrackerReadInScope(jira, 'ENG-7', async () => loaded)).toBe(false);
    expect(await isTrackerReadInScope(jira, 'PAY-7', async () => loaded)).toBe(true);
  });

  it("uses the template's team for a run with a non-git connection, and a repository's own team otherwise", async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ t1: ['PAY'], tpl: ['ENG'] }));
    const nonGit = await runTrackerScope(
      { connection: null, knowledgeRepoSources: null },
      { teamId: 'tpl' }
    );
    expect(nonGit.allowedProjectKeys).toEqual(['ENG']);
    const withRepo = await repoTrackerScope([repo({ teamId: 't1' })], { teamId: 'tpl' });
    expect(withRepo.allowedProjectKeys).toEqual(['PAY']);
  });

  it('resolves at GLOBAL only for a global template (no launch team)', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ '': ['PAY'], tpl: ['ENG'] }));
    expect((await repoTrackerScope([], null)).allowedProjectKeys).toEqual(['PAY']);
    expect((await repoTrackerScope([], { teamId: null })).allowedProjectKeys).toEqual(['PAY']);
  });

  it('flags the scope unreadable when a stored value fails the schema, instead of degrading', async () => {
    mocks.overrideAt.mockImplementation((_key, scope) =>
      scope === 'TEAM' ? 'not-a-list' : undefined
    );
    const loaded = await repoTrackerScope([repo({ teamId: 't1' })]);
    expect(loaded.projectKeysUnreadable).toBe(true);
    expect(await isTrackerReadInScope({ provider: 'linear' }, 'ENG-1', async () => loaded)).toBe(
      false
    );
    mocks.overrideAt.mockImplementation((_key, scope) => (scope === 'TEAM' ? ['PAY'] : undefined));
    expect(
      (await repoTrackerScope([repo({ teamId: 't1' })])).projectKeysUnreadable
    ).toBeUndefined();
  });
});

describe('allowedProjectKeys for a launch with launcher teams', () => {
  const byTeam =
    (lists: Record<string, string[]>) => async (key: string, ctx: { teamId?: string }) =>
      key === 'tracker.allowedProjectKeys' ? (lists[ctx.teamId ?? ''] ?? []) : [];
  const jira = { provider: 'jira' };

  it("unions the non-empty lists of the launcher's teams", async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ t1: ['PAY'], t2: ['hr'], t3: [] }));
    const loaded = await repoTrackerScope(
      [],
      [
        { orgId: 'o1', teamId: 't1' },
        { orgId: 'o1', teamId: 't2' },
        { orgId: null, teamId: 't3' },
      ]
    );
    expect(loaded.allowedProjectKeys.sort()).toEqual(['PAY', 'hr']);
    expect(await isTrackerReadInScope(jira, 'ENG-7', async () => loaded)).toBe(false);
    expect(await isTrackerReadInScope(jira, 'PAY-7', async () => loaded)).toBe(true);
    expect(await isTrackerReadInScope(jira, 'HR-7', async () => loaded)).toBe(true);
  });

  it('is unrestricted only when every launcher team lists nothing', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({}));
    const loaded = await repoTrackerScope([], [{ teamId: 't1' }, { teamId: 't2' }]);
    expect(loaded.allowedProjectKeys).toEqual([]);
    expect(await isTrackerReadInScope(jira, 'ENG-7', async () => loaded)).toBe(true);
  });

  it("lets a launcher team's list override GLOBAL: GLOBAL is not unioned in", async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ '': ['ENG'], t1: ['PAY'] }));
    const loaded = await repoTrackerScope([], [{ teamId: 't1' }]);
    expect(loaded.allowedProjectKeys).toEqual(['PAY']);
    expect(await isTrackerReadInScope(jira, 'ENG-7', async () => loaded)).toBe(false);
  });

  it('loads the launch contexts only when a targeted repository names no team', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ r: ['REPO'], t1: ['PAY'] }));
    const launch = vi.fn(async () => [{ teamId: 't1' }]);
    expect((await repoTrackerScope([repo({ teamId: 'r' })], launch)).allowedProjectKeys).toEqual([
      'REPO',
    ]);
    expect(launch).not.toHaveBeenCalled();
    expect((await repoTrackerScope([repo()], launch)).allowedProjectKeys).toEqual(['PAY']);
    expect(launch).toHaveBeenCalledTimes(1);
    await repoTrackerScope([repo(), repo({ repoName: 'Api' })], launch);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('does not refuse on a failing launch lookup the repository made unnecessary', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ r: ['REPO'] }));
    const launch = vi.fn(async () => {
      throw new Error('db down');
    });
    const loaded = await repoTrackerScope([repo({ teamId: 'r' })], launch);
    expect(loaded.projectKeysUnreadable).toBeUndefined();
    expect(loaded.allowedProjectKeys).toEqual(['REPO']);
  });

  it('is unreadable, so a read is refused, when a needed launch lookup fails', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({}));
    const launch = vi.fn(async () => {
      throw new Error('db down');
    });
    const loaded = await repoTrackerScope([], launch);
    expect(loaded.projectKeysUnreadable).toBe(true);
    expect(await isTrackerReadInScope(jira, 'PAY-7', async () => loaded)).toBe(false);
  });

  it('resolves at GLOBAL only for an empty list of teams', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ '': ['GLOB'], t1: ['PAY'] }));
    expect((await repoTrackerScope([], [])).allowedProjectKeys).toEqual(['GLOB']);
  });

  it('is unreadable when any launcher team list cannot be read', async () => {
    mocks.resolveSetting.mockImplementation(async (_key: string, ctx: { teamId?: string }) => {
      if (ctx.teamId === 't2') {
        throw new Error('db down');
      }
      return ['PAY'];
    });
    const loaded = await repoTrackerScope([], [{ teamId: 't1' }, { teamId: 't2' }]);
    expect(loaded.projectKeysUnreadable).toBe(true);
    expect(await isTrackerReadInScope(jira, 'PAY-7', async () => loaded)).toBe(false);
  });

  it('leaves a repository with its own team alone, and uses the teams for one without', async () => {
    mocks.resolveSetting.mockImplementation(byTeam({ r: ['REPO'], t1: ['PAY'] }));
    const teams = [{ teamId: 't1' }];
    expect((await repoTrackerScope([repo({ teamId: 'r' })], teams)).allowedProjectKeys).toEqual([
      'REPO',
    ]);
    expect((await repoTrackerScope([repo()], teams)).allowedProjectKeys).toEqual(['PAY']);
  });
});

describe('launcher team loaders', () => {
  it("reads a user's active memberships with their organizations", async () => {
    mocks.findMemberships.mockResolvedValue([
      { team: { orgId: 'o1' }, teamId: 't1' },
      { team: { orgId: null }, teamId: 't2' },
    ]);
    expect(await loadUserTrackerTeams('u1')).toEqual([
      { orgId: 'o1', teamId: 't1' },
      { orgId: null, teamId: 't2' },
    ]);
    expect(mocks.findMemberships).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { team: { isActive: true, organization: { isActive: true } }, userId: 'u1' },
      })
    );
  });

  it('uses the template team when there is one, and never reads the launcher', async () => {
    mocks.findWorkflowRun.mockResolvedValue({
      launchedById: 'u1',
      template: { team: { orgId: 'o1' }, teamId: 'tpl' },
    });
    expect(await loadRunLaunchContexts('ri-1', 'u1')).toEqual([{ orgId: 'o1', teamId: 'tpl' }]);
    expect(mocks.findMemberships).not.toHaveBeenCalled();
  });

  it("uses the given launcher's teams for a global template, and none for a null launcher", async () => {
    mocks.findWorkflowRun.mockResolvedValue({
      launchedById: 'someone-else',
      template: { team: null, teamId: null },
    });
    mocks.findMemberships.mockResolvedValue([{ team: { orgId: 'o1' }, teamId: 't1' }]);
    expect(await loadRunLaunchContexts('ri-1', async () => 'u1')).toEqual([
      { orgId: 'o1', teamId: 't1' },
    ]);
    expect(mocks.findMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }) })
    );
    mocks.findMemberships.mockClear();
    expect(await loadRunLaunchContexts('ri-1', null)).toEqual([]);
    expect(mocks.findMemberships).not.toHaveBeenCalled();
  });

  it("falls back to the newest run row's launcher when none is given", async () => {
    mocks.findWorkflowRun.mockResolvedValue({
      launchedById: 'u7',
      template: { team: null, teamId: null },
    });
    mocks.findMemberships.mockResolvedValue([{ team: { orgId: null }, teamId: 't7' }]);
    expect(await loadRunLaunchContexts('ri-1')).toEqual([{ orgId: null, teamId: 't7' }]);
  });

  it('throws when the database does, so a caller refuses', async () => {
    mocks.findWorkflowRun.mockRejectedValue(new Error('db down'));
    await expect(loadRunLaunchContexts('ri-1', 'u1')).rejects.toThrow();
  });
});

describe('isTrackerWriteInScope', () => {
  const loaded =
    (allowed: string[], unreadable = false): (() => Promise<TrackerRepoScope>) =>
    async () => ({ ...scope(), allowedProjectKeys: allowed, projectKeysUnreadable: unreadable });

  it('applies the read rule to Jira and Linear', async () => {
    for (const provider of ['jira', 'linear']) {
      const cfg = { provider };
      expect(await isTrackerWriteInScope(cfg, 'PAY-7', loaded(['pay']))).toBe(true);
      expect(await isTrackerWriteInScope(cfg, 'ENG-7', loaded(['PAY']))).toBe(false);
      expect(await isTrackerWriteInScope(cfg, 'not a key', loaded(['PAY']))).toBe(false);
      expect(await isTrackerWriteInScope(cfg, 'ENG-7', loaded([]))).toBe(true);
      expect(await isTrackerWriteInScope(cfg, 'PAY-7', loaded([], true))).toBe(false);
    }
  });

  it('refuses when the scope cannot be loaded, and never throws', async () => {
    expect(
      await isTrackerWriteInScope({ provider: 'jira' }, 'PAY-7', async () => {
        throw new Error('boom');
      })
    ).toBe(false);
  });

  it('resolves no default repository for GitHub: a bare number is refused', async () => {
    const s = scope(repo());
    expect(await isTrackerWriteInScope({ provider: 'github' }, 'acme/web#1', async () => s)).toBe(
      true
    );
    expect(await isTrackerWriteInScope({ provider: 'github' }, '#1', async () => s)).toBe(false);
  });
});

describe('syncTrackerOnEvent on Jira and Linear', () => {
  const JIRA = { apiToken: 't', baseUrl: null, provider: 'jira' } as ResolvedIssueTrackerConfig;
  const LINEAR = { apiToken: 't', baseUrl: null, provider: 'linear' } as ResolvedIssueTrackerConfig;
  const event = (issueId: string) => ({ issueId, type: 'ci_passed' }) as const;
  const stored = (list: string[]) =>
    mocks.resolveSetting.mockImplementation(async (key: string) =>
      key === 'tracker.allowedProjectKeys' ? list : []
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProvider.mockReturnValue({ syncOnEvent: mocks.syncOnEvent });
    mocks.findRunInput.mockResolvedValue({ connection: null, knowledgeRepoSources: null });
    mocks.findWorkflowRun.mockResolvedValue(null);
  });

  it.each([JIRA, LINEAR])('writes an allowed key (%#)', async (config) => {
    stored(['pay']);
    const warn = vi.fn();
    expect(
      await syncTrackerOnEvent(event('PAY-7'), config, { runInputId: 'ri-1', warn })
    ).toBeNull();
    expect(mocks.syncOnEvent).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([JIRA, LINEAR])(
    'skips a disallowed key, with the fixed line only (%#)',
    async (config) => {
      stored(['PAY']);
      const warn = vi.fn();
      const onOutcome = vi.fn();
      expect(
        await syncTrackerOnEvent(event('ENG-7'), config, { onOutcome, runInputId: 'ri-1', warn })
      ).toBe('out_of_scope');
      expect(mocks.createProvider).not.toHaveBeenCalled();
      expect(mocks.syncOnEvent).not.toHaveBeenCalled();
      expect(onOutcome).toHaveBeenCalledWith({ failure: 'out_of_scope', wrote: false });
      expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_PROJECT_OUT_OF_SCOPE, {
        event: 'ci_passed',
        runInputId: 'ri-1',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ENG-7');
    }
  );

  it('skips as unknown, not out_of_scope, when the list cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    const warn = vi.fn();
    expect(await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn })).toBe(
      'unknown'
    );
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_FAILED, {
      event: 'ci_passed',
      runInputId: 'ri-1',
    });
  });

  it('skips as unknown when loading the scope throws, writing nothing', async () => {
    mocks.findRunInput.mockRejectedValue(new Error('db down'));
    expect(
      await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn: vi.fn() })
    ).toBe('unknown');
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
  });

  it('skips as unknown when a needed launch lookup fails', async () => {
    mocks.findWorkflowRun.mockRejectedValue(new Error('db down'));
    expect(
      await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn: vi.fn() })
    ).toBe('unknown');
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
  });

  it('does not look up the launch when the run targets a repository with a team', async () => {
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo({ teamId: 'r' }), type: 'git_repo' },
      knowledgeRepoSources: null,
    });
    mocks.findWorkflowRun.mockRejectedValue(new Error('db down'));
    mocks.resolveSetting.mockImplementation(async (key: string, ctx: { teamId?: string }) =>
      key === 'tracker.allowedProjectKeys' && ctx.teamId === 'r' ? ['PAY'] : []
    );
    expect(
      await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn: vi.fn() })
    ).toBeNull();
    expect(mocks.findWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.findMemberships).not.toHaveBeenCalled();
  });

  it('skips as unknown when the run input cannot be found', async () => {
    mocks.findRunInput.mockResolvedValue(null);
    expect(
      await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn: vi.fn() })
    ).toBe('unknown');
  });

  it('is unrestricted with an empty list', async () => {
    stored([]);
    expect(await syncTrackerOnEvent(event('ENG-7'), JIRA, { runInputId: 'ri-1' })).toBeNull();
    expect(mocks.syncOnEvent).toHaveBeenCalledOnce();
  });

  it('gates workflow_started too: it transitions the ticket', async () => {
    stored(['PAY']);
    const out = await syncTrackerOnEvent({ issueId: 'ENG-7', type: 'workflow_started' }, JIRA, {
      runInputId: 'ri-1',
      warn: vi.fn(),
    });
    expect(out).toBe('out_of_scope');
  });

  it("holds a global-template run to its launcher's teams", async () => {
    mocks.findWorkflowRun.mockResolvedValue({
      launchedById: 'u1',
      template: { team: null, teamId: null },
    });
    mocks.findMemberships.mockResolvedValue([{ team: { orgId: null }, teamId: 't1' }]);
    mocks.resolveSetting.mockImplementation(async (key: string, ctx: { teamId?: string }) =>
      key === 'tracker.allowedProjectKeys' && ctx.teamId === 't1' ? ['PAY'] : []
    );
    const warn = vi.fn();
    expect(await syncTrackerOnEvent(event('ENG-7'), JIRA, { runInputId: 'ri-1', warn })).toBe(
      'out_of_scope'
    );
    expect(await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: 'ri-1', warn })).toBeNull();
    // An explicit launcher wins over the run row's, and null means GLOBAL only (unrestricted here).
    expect(
      await syncTrackerOnEvent(event('ENG-7'), JIRA, { launcher: null, runInputId: 'ri-1', warn })
    ).toBeNull();
  });

  it('with no run input resolves the list at GLOBAL', async () => {
    stored(['PAY']);
    expect(
      await syncTrackerOnEvent(event('ENG-7'), JIRA, { runInputId: null, warn: vi.fn() })
    ).toBe('out_of_scope');
    expect(await syncTrackerOnEvent(event('PAY-7'), JIRA, { runInputId: null })).toBeNull();
  });
});

describe('isTrackerReadInScope', () => {
  const GITHUB = { baseUrl: null, provider: 'github' };
  const web = { owner: 'acme', repo: 'web' };

  it('allows an issue in a repository of the scope', async () => {
    const load = vi.fn(async () => scope(repo()));
    expect(await isTrackerReadInScope(GITHUB, 'acme/web#1', load)).toBe(true);
    expect(await isTrackerReadInScope(GITHUB, '#1', load, web)).toBe(true);
  });

  it('refuses a foreign repository, a bare number and a host mismatch', async () => {
    const load = vi.fn(async () => scope(repo()));
    expect(await isTrackerReadInScope(GITHUB, 'attacker/private#1', load)).toBe(false);
    expect(await isTrackerReadInScope(GITHUB, '#1', load)).toBe(false);
    const ghe = { baseUrl: 'https://ghe.corp/api/v3', provider: 'github' };
    expect(await isTrackerReadInScope(ghe, 'acme/web#1', load)).toBe(false);
  });

  it('does not gate a null provider, nor load a scope for it', async () => {
    const load = vi.fn(async () => scope());
    expect(await isTrackerReadInScope({ provider: null }, 'X-1', load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  describe.each(['jira', 'linear'])('%s project keys', (provider) => {
    const cfg = { provider };
    const withKeys = (...keys: string[]) =>
      vi.fn(async () => ({ ...scope(repo()), allowedProjectKeys: keys }));

    it('is unrestricted with an empty list', async () => {
      expect(await isTrackerReadInScope(cfg, 'ANY-1', withKeys())).toBe(true);
      expect(await isTrackerReadInScope(cfg, 'not an id', withKeys())).toBe(true);
    });

    it('allows a listed key and refuses another, case-insensitively', async () => {
      const load = withKeys('PAY', 'Eng');
      expect(await isTrackerReadInScope(cfg, 'PAY-12', load)).toBe(true);
      expect(await isTrackerReadInScope(cfg, 'pay-12', load)).toBe(true);
      expect(await isTrackerReadInScope(cfg, 'ENG-45', load)).toBe(true);
      expect(await isTrackerReadInScope(cfg, 'HR-1', load)).toBe(false);
      expect(await isTrackerReadInScope(cfg, 'PAYX-1', load)).toBe(false);
    });

    it('refuses an id with no parseable key when a list is set', async () => {
      const load = withKeys('PAY');
      for (const id of [
        '',
        '12',
        'PAY',
        'PAY-',
        'PAY-1-x',
        'https://x/browse/PAY-1',
        'acme/web#1',
      ]) {
        expect(await isTrackerReadInScope(cfg, id, load), id).toBe(false);
      }
    });

    it('refuses, and never throws, when the scope cannot be loaded or read', async () => {
      const boom = vi.fn(async () => {
        throw new Error('db down');
      });
      expect(await isTrackerReadInScope(cfg, 'PAY-1', boom)).toBe(false);
      const unreadable = vi.fn(async () => ({ ...scope(), projectKeysUnreadable: true }));
      expect(await isTrackerReadInScope(cfg, 'PAY-1', unreadable)).toBe(false);
    });
  });

  it('refuses, and never throws, when the scope cannot be loaded', async () => {
    const load = vi.fn(async () => {
      throw new Error('db down');
    });
    expect(await isTrackerReadInScope(GITHUB, 'acme/web#1', load)).toBe(false);
  });
});

describe('syncTrackerOnEvent', () => {
  const GITHUB = { apiToken: 't', baseUrl: null, provider: 'github' } as ResolvedIssueTrackerConfig;
  const EVENT = { issueId: 'acme/web#7', type: 'workflow_completed' } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProvider.mockReturnValue({ syncOnEvent: mocks.syncOnEvent });
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo(), type: 'git_repo' },
      knowledgeRepoSources: null,
    });
    mocks.findConnections.mockResolvedValue([]);
  });

  it("syncs a GitHub ticket in the run's own repository", async () => {
    const warn = vi.fn();
    await syncTrackerOnEvent(EVENT, GITHUB, { runInputId: 'wr-1', warn });
    expect(mocks.findRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wr-1' } })
    );
    expect(mocks.syncOnEvent).toHaveBeenCalledWith(EVENT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('syncs a GitHub ticket in a repository the launch was authorized against', async () => {
    mocks.findRunInput.mockResolvedValue({
      connection: null,
      knowledgeRepoSources: [{ repoId: 'repo-2' }],
    });
    mocks.findConnections.mockResolvedValue([repo({ repoName: 'api' })]);
    await syncTrackerOnEvent({ ...EVENT, issueId: 'acme/api#3' }, GITHUB, { runInputId: 'wr-1' });
    expect(mocks.findConnections).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['repo-2'] }, type: 'git_repo' } })
    );
    expect(mocks.syncOnEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a foreign repository', 'attacker/public#1', TRACKER_SYNC_OUT_OF_SCOPE],
    ['a bare issue number', '#7', TRACKER_SYNC_NO_REPOSITORY],
  ])('refuses %s without writing, and logs a fixed line', async (_label, issueId, line) => {
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, issueId }, GITHUB, { runInputId: 'wr-1', warn });
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(line, {
      event: 'workflow_completed',
      runInputId: 'wr-1',
    });
  });

  it('syncs a ticket in a repository the operator listed, resolved at the run team', async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo(), team: { orgId: 'org-1' }, teamId: 'team-1', type: 'git_repo' },
      knowledgeRepoSources: null,
    });
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, issueId: 'acme/issues#5' }, GITHUB, {
      runInputId: 'wr-1',
      warn,
    });
    expect(mocks.syncOnEvent).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.resolveSetting).toHaveBeenCalledWith('github.trackerIssueRepositories', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('refuses a listed repository when the setting cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo(), teamId: 'team-1', type: 'git_repo' },
      knowledgeRepoSources: null,
    });
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, issueId: 'acme/issues#5' }, GITHUB, {
      runInputId: 'wr-1',
      warn,
    });
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_OUT_OF_SCOPE, {
      event: 'workflow_completed',
      runInputId: 'wr-1',
    });
  });

  it('refuses a listed repository on a run with no connection', async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    mocks.findRunInput.mockResolvedValue({ connection: null, knowledgeRepoSources: null });
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, issueId: 'acme/issues#5' }, GITHUB, {
      runInputId: 'wr-1',
      warn,
    });
    expect(mocks.resolveSetting).not.toHaveBeenCalledWith(
      'github.trackerIssueRepositories',
      expect.anything()
    );
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a GitHub ticket when the caller names no run', async () => {
    const warn = vi.fn();
    await syncTrackerOnEvent(EVENT, GITHUB, { runInputId: null, warn });
    expect(mocks.findRunInput).not.toHaveBeenCalled();
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_OUT_OF_SCOPE, {
      event: 'workflow_completed',
      runInputId: null,
    });
  });

  it("refuses when the run's connection is not a git repository", async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/web']);
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo(), teamId: 'team-1', type: 'issue_tracker' },
      knowledgeRepoSources: null,
    });
    const warn = vi.fn();
    await syncTrackerOnEvent(EVENT, GITHUB, { runInputId: 'wr-1', warn });
    expect(mocks.resolveSetting).not.toHaveBeenCalledWith(
      'github.trackerIssueRepositories',
      expect.anything()
    );
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a repository on another host than the tracker writes to', async () => {
    const warn = vi.fn();
    const ghe = { ...GITHUB, baseUrl: 'https://ghe.corp/api/v3' };
    await syncTrackerOnEvent(EVENT, ghe, { runInputId: 'wr-1', warn });
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the repository lookup fails', async () => {
    mocks.findRunInput.mockRejectedValue(new Error('db down'));
    const warn = vi.fn();
    await syncTrackerOnEvent(EVENT, GITHUB, { runInputId: 'wr-1', warn });
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_FAILED, {
      event: EVENT.type,
      runInputId: 'wr-1',
    });
  });

  it('does nothing, and reads nothing, for workflow_started on GitHub', async () => {
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, type: 'workflow_started' }, GITHUB, {
      runInputId: 'wr-1',
      warn,
    });
    expect(mocks.findRunInput).not.toHaveBeenCalled();
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['jira', 'linear'] as const)('does not apply the repository check to %s', async (p) => {
    const warn = vi.fn();
    await syncTrackerOnEvent(
      { ...EVENT, issueId: 'attacker/public#1' },
      { ...GITHUB, provider: p },
      { runInputId: null, warn }
    );
    expect(mocks.findRunInput).not.toHaveBeenCalled();
    expect(mocks.syncOnEvent).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('the outcome it reports through onOutcome', () => {
    const JIRA = { ...GITHUB, provider: 'jira' } as ResolvedIssueTrackerConfig;

    it('passes through what a provider that reports its writes says', async () => {
      const onOutcome = vi.fn();
      mocks.createProvider.mockReturnValue({
        syncOnEvent: mocks.syncOnEvent,
        syncOnEventOutcome: vi.fn(async () => ({ failure: null, wrote: false })),
      });
      await expect(
        syncTrackerOnEvent(EVENT, JIRA, { onOutcome, runInputId: null })
      ).resolves.toBeNull();
      expect(onOutcome).toHaveBeenCalledWith({ failure: null, wrote: false });
      expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    });

    it('takes a provider that cannot say to have written', async () => {
      const onOutcome = vi.fn();
      mocks.syncOnEvent.mockResolvedValueOnce(null);
      await syncTrackerOnEvent(EVENT, JIRA, { onOutcome, runInputId: null });
      expect(onOutcome).toHaveBeenCalledWith({ failure: null, wrote: true });
    });

    it('says nothing was written for GitHub workflow_started and for a declined scope', async () => {
      const onOutcome = vi.fn();
      await syncTrackerOnEvent({ ...EVENT, type: 'workflow_started' }, GITHUB, {
        onOutcome,
        runInputId: 'wr-1',
      });
      expect(onOutcome).toHaveBeenLastCalledWith({ failure: null, wrote: false });
      await syncTrackerOnEvent({ ...EVENT, issueId: 'attacker/public#1' }, GITHUB, {
        onOutcome,
        runInputId: 'wr-1',
        warn: vi.fn(),
      });
      expect(onOutcome).toHaveBeenLastCalledWith({ failure: 'out_of_scope', wrote: false });
    });

    it('says nothing was written when the sync throws, and a throwing sink changes nothing', async () => {
      const onOutcome = vi.fn(() => {
        throw new Error('sink');
      });
      mocks.syncOnEvent.mockRejectedValueOnce(new Error('db down'));
      await expect(
        syncTrackerOnEvent(EVENT, JIRA, { onOutcome, runInputId: null, warn: vi.fn() })
      ).resolves.toBe('unknown');
      expect(onOutcome).toHaveBeenCalledWith({ failure: 'unknown', wrote: false });
    });
  });

  describe('the comment failure it reports', () => {
    const JIRA = { ...GITHUB, provider: 'jira' } as ResolvedIssueTrackerConfig;

    it('is null when the provider reports no failure', async () => {
      mocks.syncOnEvent.mockResolvedValueOnce(null);
      await expect(syncTrackerOnEvent(EVENT, JIRA, { runInputId: null })).resolves.toBeNull();
    });

    it("is the provider's failure class", async () => {
      mocks.syncOnEvent.mockResolvedValueOnce('forbidden');
      await expect(syncTrackerOnEvent(EVENT, JIRA, { runInputId: null })).resolves.toBe(
        'forbidden'
      );
    });

    it('is unknown when the sync itself throws, and still warns with the fixed line', async () => {
      mocks.syncOnEvent.mockRejectedValueOnce(new Error('db down'));
      const warn = vi.fn();
      await expect(syncTrackerOnEvent(EVENT, JIRA, { runInputId: null, warn })).resolves.toBe(
        'unknown'
      );
      expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_FAILED, expect.anything());
    });

    it('is out_of_scope for a write the repository check refused: the ticket was not updated', async () => {
      const warn = vi.fn();
      await expect(
        syncTrackerOnEvent({ ...EVENT, issueId: 'attacker/public#1' }, GITHUB, {
          runInputId: 'wr-1',
          warn,
        })
      ).resolves.toBe('out_of_scope');
      expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_OUT_OF_SCOPE, {
        event: 'workflow_completed',
        runInputId: 'wr-1',
      });
      expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    });

    it('is out_of_scope for a failed event refused for want of a run, too', async () => {
      await expect(
        syncTrackerOnEvent({ ...EVENT, type: 'workflow_failed' }, GITHUB, {
          runInputId: null,
          warn: vi.fn(),
        })
      ).resolves.toBe('out_of_scope');
    });

    it.each(
      ['123', '#123'].flatMap((id) =>
        (['workflow_completed', 'workflow_failed'] as const).map((type) => [id, type] as const)
      )
    )(
      'is no_repository for the bare GitHub id %s on %s: nothing is written, no repository can be resolved from the id',
      async (issueId, type) => {
        const warn = vi.fn();
        await expect(
          syncTrackerOnEvent({ ...EVENT, issueId, type }, GITHUB, { runInputId: 'wr-1', warn })
        ).resolves.toBe('no_repository');
        expect(mocks.syncOnEvent).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_NO_REPOSITORY, {
          event: type,
          runInputId: 'wr-1',
        });
      }
    );

    it.each(['https://github.com/acme/web/issues/42', 'acme/web', 'UIP-15211'])(
      'is no_repository for the unparseable GitHub id %s, and the provider is not called',
      async (issueId) => {
        const warn = vi.fn();
        await expect(
          syncTrackerOnEvent({ ...EVENT, issueId }, GITHUB, { runInputId: 'wr-1', warn })
        ).resolves.toBe('no_repository');
        expect(mocks.syncOnEvent).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_NO_REPOSITORY, expect.anything());
        expect(warn).not.toHaveBeenCalledWith(TRACKER_SYNC_OUT_OF_SCOPE, expect.anything());
      }
    );

    it('words the two lines apart, without ticket text', () => {
      expect(TRACKER_SYNC_NO_REPOSITORY).not.toBe(TRACKER_SYNC_OUT_OF_SCOPE);
      expect(TRACKER_SYNC_NO_REPOSITORY).toMatch(/names no repository/);
    });

    it('is no_repository for a bare GitHub id when the caller names no run, too', async () => {
      await expect(
        syncTrackerOnEvent({ ...EVENT, issueId: '123' }, GITHUB, {
          runInputId: null,
          warn: vi.fn(),
        })
      ).resolves.toBe('no_repository');
      expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    });

    it('is null for a bare GitHub id on workflow_started, which writes nothing', async () => {
      const warn = vi.fn();
      await expect(
        syncTrackerOnEvent({ ...EVENT, issueId: '123', type: 'workflow_started' }, GITHUB, {
          runInputId: 'wr-1',
          warn,
        })
      ).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    });

    it('calls the provider for an explicit in-scope repository', async () => {
      mocks.syncOnEvent.mockResolvedValue(null);
      await expect(
        syncTrackerOnEvent(EVENT, GITHUB, { runInputId: 'wr-1', warn: vi.fn() })
      ).resolves.toBeNull();
      expect(mocks.syncOnEvent).toHaveBeenCalledTimes(1);
    });

    it('is null for workflow_started on GitHub, which writes nothing', async () => {
      await expect(
        syncTrackerOnEvent({ ...EVENT, type: 'workflow_started' }, GITHUB, {
          runInputId: 'wr-1',
          warn: vi.fn(),
        })
      ).resolves.toBeNull();
    });
  });
});
