import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  findConnections: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  findRunInput: vi.fn(),
  resolveSetting: vi.fn(),
  syncOnEvent: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../db.js', () => ({
  prisma: {
    connection: { findMany: (...args: unknown[]) => mocks.findConnections(...args) },
    runInput: { findUnique: (...args: unknown[]) => mocks.findRunInput(...args) },
  },
}));
vi.mock('../config/index.js', () => ({
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
  repoTrackerScope,
  resolveTrackerIssueRepos,
  syncTrackerOnEvent,
  TRACKER_SYNC_FAILED,
  TRACKER_SYNC_OUT_OF_SCOPE,
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
  instanceBaseUrl: DOTCOM,
  repos,
});

beforeEach(() => {
  mocks.resolveSetting.mockReset();
  mocks.resolveSetting.mockResolvedValue([]);
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
    const onGhe: TrackerRepoScope = { instanceBaseUrl: 'https://ghe.corp', repos: [repo()] };
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
      extraRepos: [],
      instanceBaseUrl: DOTCOM,
      repos,
    });
  });

  it("resolves the list at the first repository's team and organization", async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    const repos = [repo({ team: { orgId: 'org-1' }, teamId: 'team-1' })];
    expect((await repoTrackerScope(repos)).extraRepos).toEqual(['acme/issues']);
    expect(mocks.resolveSetting).toHaveBeenCalledWith('github.trackerIssueRepositories', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('does not throw, and lists nothing, when the setting cannot be read', async () => {
    mocks.resolveSetting.mockRejectedValue(new Error('db down'));
    expect((await repoTrackerScope([repo({ teamId: 'team-1' })])).extraRepos).toEqual([]);
  });

  it('lists nothing, and reads no setting, for a repository with no owning team', async () => {
    mocks.resolveSetting.mockResolvedValue(['acme/issues']);
    expect((await repoTrackerScope([repo()])).extraRepos).toEqual([]);
    expect(mocks.resolveSetting).not.toHaveBeenCalled();
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

  it.each(['jira', 'linear'])('does not gate %s, nor load a scope for it', async (provider) => {
    const load = vi.fn(async () => scope());
    expect(await isTrackerReadInScope({ provider }, 'attacker/private#1', load)).toBe(true);
    expect(await isTrackerReadInScope({ provider: null }, 'X-1', load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
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
    ['a foreign repository', 'attacker/public#1'],
    ['a bare issue number', '#7'],
  ])('refuses %s without writing, and logs a fixed line', async (_label, issueId) => {
    const warn = vi.fn();
    await syncTrackerOnEvent({ ...EVENT, issueId }, GITHUB, { runInputId: 'wr-1', warn });
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.syncOnEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(TRACKER_SYNC_OUT_OF_SCOPE, {
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
    expect(mocks.resolveSetting).not.toHaveBeenCalled();
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
    expect(mocks.resolveSetting).not.toHaveBeenCalled();
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
});
