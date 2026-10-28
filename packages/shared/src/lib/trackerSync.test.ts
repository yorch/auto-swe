import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  findConnections: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  findRunInput: vi.fn(),
  syncOnEvent: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../db.js', () => ({
  prisma: {
    connection: { findMany: (...args: unknown[]) => mocks.findConnections(...args) },
    runInput: { findUnique: (...args: unknown[]) => mocks.findRunInput(...args) },
  },
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
    mocks.findRunInput.mockResolvedValue({
      connection: { ...repo(), type: 'issue_tracker' },
      knowledgeRepoSources: null,
    });
    const warn = vi.fn();
    await syncTrackerOnEvent(EVENT, GITHUB, { runInputId: 'wr-1', warn });
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
