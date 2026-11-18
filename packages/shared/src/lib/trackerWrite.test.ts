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
  createTargetProjectKey,
  createTrackerEpic,
  createTrackerStory,
  isTargetProjectKeyAllowed,
  TRACKER_PROJECT_OUT_OF_SCOPE,
  trackerProjectNotAllowedMessage,
} from './trackerWrite.js';

const GITHUB = { baseUrl: null, provider: 'github' } as unknown as ResolvedIssueTrackerConfig;
const SCOPE: TrackerRepoScope = {
  allowedProjectKeys: [],
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

  it.each(['victim-org/private-repo', 'acme/web#9', 'acme', 'acme/web/extra'])(
    'refuses %j and creates nothing',
    async (key) => {
      expect(await createTrackerEpic(GITHUB, EPIC, key, { scope: SCOPE, warn })).toBeNull();
      expect(await createTrackerStory(GITHUB, STORY, key, null, { scope: SCOPE, warn })).toBeNull();
      expect(mocks.createIssue).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(TRACKER_PROJECT_OUT_OF_SCOPE);
    }
  );

  it('creates in a repository the operator listed, and refuses one that is not', async () => {
    const listed: TrackerRepoScope = { ...SCOPE, extraRepos: ['Acme/Issues'] };
    expect(
      await createTrackerEpic(GITHUB, EPIC, 'acme/issues', { scope: listed, warn })
    ).not.toBeNull();
    expect(
      await createTrackerStory(GITHUB, STORY, 'ACME/ISSUES', null, { scope: listed, warn })
    ).not.toBeNull();
    expect(mocks.createIssue).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(await createTrackerEpic(GITHUB, EPIC, 'acme/other', { scope: listed, warn })).toBeNull();
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

describe('isTargetProjectKeyAllowed', () => {
  it('allows a listed key, case-insensitively', () => {
    expect(isTargetProjectKeyAllowed('pay', { allowedProjectKeys: ['PAY'] })).toBe(true);
    expect(isTargetProjectKeyAllowed('PAY', { allowedProjectKeys: ['pay'] })).toBe(true);
  });

  it('refuses a key that is not listed', () => {
    expect(isTargetProjectKeyAllowed('OPS', { allowedProjectKeys: ['PAY'] })).toBe(false);
    expect(isTargetProjectKeyAllowed('', { allowedProjectKeys: ['PAY'] })).toBe(false);
  });

  it('is unrestricted when the list is empty', () => {
    expect(isTargetProjectKeyAllowed('OPS', { allowedProjectKeys: [] })).toBe(true);
  });

  it('refuses when the list could not be read, even if it is empty', () => {
    expect(
      isTargetProjectKeyAllowed('PAY', { allowedProjectKeys: [], projectKeysUnreadable: true })
    ).toBe(false);
  });

  it('honours a union of contexts already merged into the scope', () => {
    const scope = { allowedProjectKeys: ['PAY', 'OPS'] };
    expect(isTargetProjectKeyAllowed('ops', scope)).toBe(true);
    expect(isTargetProjectKeyAllowed('pay', scope)).toBe(true);
    expect(isTargetProjectKeyAllowed('HR', scope)).toBe(false);
  });

  it('targets the key, else the configured default, else BACKLOG', () => {
    expect(createTargetProjectKey({ defaultProjectKey: 'DEF' }, 'PAY')).toBe('PAY');
    expect(createTargetProjectKey({ defaultProjectKey: 'DEF' }, null)).toBe('DEF');
    expect(createTargetProjectKey({ defaultProjectKey: undefined }, undefined)).toBe('BACKLOG');
  });

  it('names the key and the admin setting in the refusal', () => {
    const message = trackerProjectNotAllowedMessage('OPS');
    expect(message).toContain('OPS');
    expect(message).toContain('Issue tracker');
  });
});
