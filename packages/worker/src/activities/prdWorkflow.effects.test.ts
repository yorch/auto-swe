import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createEpic: vi.fn(),
  createPage: vi.fn(),
  createStory: vi.fn(),
  record: vi.fn(async () => {}),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    runInput: {
      findUniqueOrThrow: vi.fn(async () => ({
        knowledgeRepoSources: [],
        requestPayload: JSON.stringify({ projectKey: 'PRJ' }),
      })),
    },
  },
}));
vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: vi.fn(() => ({ createPage: m.createPage })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => ({
    apiToken: 't',
    baseUrl: 'https://acme.atlassian.net',
    email: 'a@b.c',
    provider: 'jira',
  })),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({ spaces: ['PRD'] })),
}));
vi.mock('@auto-swe/shared/lib/trackerWrite', () => ({
  createTrackerEpic: m.createEpic,
  createTrackerStory: m.createStory,
}));
vi.mock('@temporalio/activity', () => ({
  activityInfo: vi.fn(),
  asyncLocalStorage: { getStore: () => undefined },
  heartbeat: vi.fn(),
}));
vi.mock('../lib/effectLedger.js', () => ({ recordEffect: m.record }));

import { createTrackerItems } from './prdWorkflow.js';

const decomposition = {
  epics: [
    {
      description: 'e',
      stories: [
        {
          acceptanceCriteria: ['a'],
          description: 's',
          storyPoints: 3,
          title: 'Story A',
        },
      ],
      title: 'Epic 1',
    },
  ],
  rationale: 'r',
};
const request = { workRequestId: 'wr-1' } as RepoWorkRequest;
const effects = () =>
  m.record.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);

beforeEach(() => {
  vi.clearAllMocks();
  m.createEpic.mockResolvedValue({
    id: 'E-1',
    title: 'Epic 1',
    type: 'epic',
    url: 'https://t/E-1',
  });
  m.createStory.mockResolvedValue({ id: 'S-1', title: 'Story A', type: 'story', url: null });
  m.createPage.mockResolvedValue({ id: 'p1', url: 'https://kb/p1' });
});

describe('createTrackerItems run effects', () => {
  it('records each tracker create and the knowledge-base page', async () => {
    const result = await createTrackerItems(request, { decomposition });
    expect(result.failedCount).toBe(0);
    expect(effects()).toEqual([
      expect.objectContaining({
        action: 'create:epic',
        kind: 'TRACKER',
        status: 'DONE',
        target: 'https://t/E-1',
      }),
      expect.objectContaining({ action: 'create:story', status: 'DONE', target: 'S-1' }),
      expect.objectContaining({
        action: 'createPage',
        kind: 'KNOWLEDGE_BASE',
        status: 'DONE',
        target: 'https://kb/p1',
      }),
    ]);
  });

  it('records the creates the tracker swallowed as failures, and the result is unchanged', async () => {
    m.createEpic.mockResolvedValue(null);
    m.createStory.mockResolvedValue(null);
    m.createPage.mockResolvedValue(null); // what Confluence returns when the create fails
    const result = await createTrackerItems(request, { decomposition });
    expect(result).toEqual({ createdItems: [], failedCount: 2 });
    expect(effects()).toEqual([
      expect.objectContaining({ action: 'create:epic', status: 'FAILED', target: 'Epic 1' }),
      expect.objectContaining({ action: 'create:story', status: 'FAILED' }),
      expect.objectContaining({
        action: 'createPage',
        kind: 'KNOWLEDGE_BASE',
        status: 'FAILED',
      }),
    ]);
  });

  it('records a rejecting createPage as failed', async () => {
    m.createPage.mockRejectedValue(new Error('confluence 500'));
    await createTrackerItems(request, { decomposition });
    expect(effects().filter((e) => e.kind === 'KNOWLEDGE_BASE')).toEqual([
      expect.objectContaining({ action: 'createPage', error: expect.anything(), status: 'FAILED' }),
    ]);
  });

  it('records nothing when the knowledge-base config lookup fails (not a write)', async () => {
    const systemConfig = await import('@auto-swe/shared/lib/systemConfig');
    vi.mocked(systemConfig.resolveKnowledgeBaseConfig).mockRejectedValueOnce(new Error('cfg'));
    const result = await createTrackerItems(request, { decomposition });
    expect(result.failedCount).toBe(0);
    expect(m.createPage).not.toHaveBeenCalled();
    expect(effects().filter((e) => e.kind === 'KNOWLEDGE_BASE')).toEqual([]);
  });

  it('records no page when Notion has no space to create it in (nothing was sent)', async () => {
    const systemConfig = await import('@auto-swe/shared/lib/systemConfig');
    vi.mocked(systemConfig.resolveKnowledgeBaseConfig).mockResolvedValueOnce({
      provider: 'notion',
      spaces: [],
    } as never);
    m.createPage.mockResolvedValue(null); // Notion returns null without a request here
    const result = await createTrackerItems(request, { decomposition });
    expect(result.failedCount).toBe(0);
    expect(effects().filter((e) => e.kind === 'KNOWLEDGE_BASE')).toEqual([]);
    expect(effects().filter((e) => e.kind === 'TRACKER')).toHaveLength(2);
  });

  it('records no tracker create when the provider cannot be built or has no owner/repo key', async () => {
    const systemConfig = await import('@auto-swe/shared/lib/systemConfig');
    m.createEpic.mockResolvedValue(null);
    m.createStory.mockResolvedValue(null);
    vi.mocked(systemConfig.resolveIssueTrackerConfig).mockResolvedValueOnce({
      apiToken: null,
      provider: 'jira',
    } as never);
    await createTrackerItems(request, { decomposition });
    vi.mocked(systemConfig.resolveIssueTrackerConfig).mockResolvedValueOnce({
      apiToken: 't',
      provider: 'github',
    } as never);
    await createTrackerItems(request, { decomposition }); // projectKey 'PRJ' is not owner/repo
    expect(effects().filter((e) => e.kind === 'TRACKER')).toEqual([]);
  });
});
