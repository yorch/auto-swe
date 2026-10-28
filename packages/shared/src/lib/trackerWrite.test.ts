import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createIssue: vi.fn(async (..._args: unknown[]) => ({
    id: 'acme/web#9',
    title: 'T',
    url: 'https://github.com/acme/web/issues/9',
  })),
}));

vi.mock('./integrations/registry.js', () => ({
  createIssueTrackerProvider: () => ({ createIssue: mocks.createIssue }),
}));

import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import type { TrackerRepoScope } from './trackerSync.js';
import {
  createTrackerEpic,
  createTrackerStory,
  TRACKER_PROJECT_OUT_OF_SCOPE,
} from './trackerWrite.js';

const GITHUB = { baseUrl: null, provider: 'github' } as unknown as ResolvedIssueTrackerConfig;
const SCOPE: TrackerRepoScope = {
  instanceBaseUrl: 'https://github.com',
  repos: [{ githubApiUrl: null, githubUrl: null, organizationName: 'Acme', repoName: 'Web' }],
};
const EPIC = { description: 'd', title: 'T' };
const STORY = { acceptanceCriteria: ['a'], description: 'd', storyPoints: 1, title: 'T' };

describe('tracker writes on the GitHub tracker', () => {
  const warn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an epic and a story in a repository the run targets', async () => {
    expect(
      await createTrackerEpic(GITHUB, EPIC, 'acme/web', { scope: SCOPE, warn })
    ).not.toBeNull();
    expect(
      await createTrackerStory(GITHUB, STORY, 'ACME/WEB', null, { scope: SCOPE, warn })
    ).not.toBeNull();
    expect(mocks.createIssue).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    'victim-org/private-repo',
    'acme/web#9',
    'acme',
    'acme/web/extra',
  ])('refuses %j and creates nothing', async (key) => {
    expect(await createTrackerEpic(GITHUB, EPIC, key, { scope: SCOPE, warn })).toBeNull();
    expect(await createTrackerStory(GITHUB, STORY, key, null, { scope: SCOPE, warn })).toBeNull();
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(TRACKER_PROJECT_OUT_OF_SCOPE);
  });

  it('refuses a project key when no scope could be loaded', async () => {
    expect(await createTrackerEpic(GITHUB, EPIC, 'acme/web', { scope: null, warn })).toBeNull();
    expect(await createTrackerEpic(GITHUB, EPIC, 'acme/web')).toBeNull();
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it('does not gate the admin default when no project key is given', async () => {
    expect(await createTrackerEpic(GITHUB, EPIC, null, { scope: null, warn })).not.toBeNull();
    expect(mocks.createIssue).toHaveBeenCalledTimes(1);
  });

  it.each(['jira', 'linear'] as const)('does not gate %s project keys', async (provider) => {
    const config = { ...GITHUB, provider } as ResolvedIssueTrackerConfig;
    expect(await createTrackerEpic(config, EPIC, 'PROJ', { scope: null, warn })).not.toBeNull();
    expect(await createTrackerStory(config, STORY, 'PROJ', null)).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
