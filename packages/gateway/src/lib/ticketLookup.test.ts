import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupTrackerTicket } from './ticketLookup.js';

const resolveIssueTrackerConfig = vi.hoisted(() => vi.fn());
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({ resolveIssueTrackerConfig }));
// The real scope loads operator settings from the database; the check itself stays real.
vi.mock('@auto-swe/shared/lib/trackerSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/trackerSync')>()),
  repoTrackerScope: async (repos: unknown[]) => ({
    extraRepos: [],
    instanceBaseUrl: 'https://github.com',
    repos,
  }),
}));
const fetchTicket = vi.hoisted(() => vi.fn());
vi.mock('./issueTrackerClient.js', () => ({ fetchTicket }));

const repo = {
  githubApiUrl: null,
  githubUrl: null,
  organizationName: 'acme',
  repoName: 'api',
  team: { orgId: null },
  teamId: 't1',
};

beforeEach(() => {
  resolveIssueTrackerConfig.mockReset();
  fetchTicket.mockReset();
});

describe('lookupTrackerTicket', () => {
  it('is unconfigured when no tracker is set up, without fetching', async () => {
    resolveIssueTrackerConfig.mockResolvedValue({ provider: null });
    expect(await lookupTrackerTicket('PAY-1', repo)).toEqual({ state: 'unconfigured' });
    expect(fetchTicket).not.toHaveBeenCalled();
  });

  it('checks scope before any fetch: a GitHub ticket outside the repo is not_found', async () => {
    resolveIssueTrackerConfig.mockResolvedValue({ baseUrl: null, provider: 'github' });
    expect(await lookupTrackerTicket('other/secret#5', repo)).toEqual({ state: 'not_found' });
    expect(fetchTicket).not.toHaveBeenCalled();
  });

  it('fetches an in-scope GitHub ticket with the connection as defaultRepo', async () => {
    const tracker = { baseUrl: null, provider: 'github' };
    resolveIssueTrackerConfig.mockResolvedValue(tracker);
    fetchTicket.mockResolvedValue({ title: 'T' });
    const res = await lookupTrackerTicket('acme/api#5', repo);
    expect(res).toEqual({ state: 'found', ticket: { title: 'T' } });
    expect(fetchTicket).toHaveBeenCalledWith(
      tracker,
      'acme/api#5',
      expect.objectContaining({ defaultRepo: { owner: 'acme', repo: 'api' } })
    );
  });

  it('is not_found when the tracker has no such ticket', async () => {
    resolveIssueTrackerConfig.mockResolvedValue({ provider: 'jira' });
    fetchTicket.mockResolvedValue(null);
    expect(await lookupTrackerTicket('PAY-1', null)).toEqual({ state: 'not_found' });
  });

  it('maps a thrown error to its own state, not unconfigured', async () => {
    resolveIssueTrackerConfig.mockRejectedValue(new Error('decrypt failed'));
    expect(await lookupTrackerTicket('PAY-1', repo)).toEqual({ state: 'error' });
    resolveIssueTrackerConfig.mockResolvedValue({ provider: 'jira' });
    fetchTicket.mockRejectedValue(new Error('boom'));
    expect(await lookupTrackerTicket('PAY-1', repo)).toEqual({ state: 'error' });
  });
});
