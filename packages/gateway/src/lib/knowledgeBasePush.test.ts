import { isUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./repositoryHost.js', () => ({
  webhookRepositoryWhere: vi.fn(async () => ({
    githubUrl: 'https://ghe.example',
    organizationName: 'org',
    repoName: 'docs',
  })),
}));

import { triggerKnowledgeBasePush } from './knowledgeBasePush.js';
import { webhookRepositoryWhere } from './repositoryHost.js';

const findMany = vi.fn();
const start = vi.fn();
const app = {
  prisma: { knowledgeBase: { findMany } },
  temporal: { startKnowledgeBaseIndex: start },
} as never;
const push = {
  after: 'a'.repeat(40),
  ref: 'refs/heads/main',
  repository: { full_name: 'org/docs', html_url: 'https://ghe.example/org/docs' },
};

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([
    { connection: { defaultBranch: 'main' }, defaultRef: null, id: 'default' },
    { connection: { defaultBranch: 'main' }, defaultRef: 'release', id: 'override' },
  ]);
});

describe('knowledge base push trigger', () => {
  it('indexes the default branch without needing a human sender or commit list', async () => {
    await triggerKnowledgeBasePush(app, push, 'ghe.example');
    expect(start).toHaveBeenCalledExactlyOnceWith('default');
    expect(webhookRepositoryWhere).toHaveBeenCalledWith(
      expect.anything(),
      'org',
      'docs',
      push.repository.html_url,
      'ghe.example'
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          connection: {
            githubUrl: 'https://ghe.example',
            isActive: true,
            organizationName: 'org',
            repoName: 'docs',
            type: 'git_repo',
          },
          status: 'OK',
        },
      })
    );
  });
  it('indexes the KB override branch rather than the connection default', async () => {
    await triggerKnowledgeBasePush(app, { ...push, ref: 'refs/heads/release' }, 'ghe.example');
    expect(start).toHaveBeenCalledExactlyOnceWith('override');
  });
  it('marks the verified repository lookup cross-tenant only for knowledge bases', async () => {
    findMany.mockImplementation(async () => {
      expect(isUnscoped('KnowledgeBase')).toBe(true);
      expect(isUnscoped('Connection')).toBe(false);
      return [];
    });
    await triggerKnowledgeBasePush(app, push, null);
    expect(start).not.toHaveBeenCalled();
    expect(isUnscoped('KnowledgeBase')).toBe(false);
  });
  it.each([
    null,
    {},
    { ...push, ref: 'refs/tags/v1' },
    { ...push, deleted: true },
    { ...push, after: '0'.repeat(40) },
    { ...push, after: 'bad' },
  ])('ignores malformed, deleted and non-branch events: %j', async (body) => {
    await triggerKnowledgeBasePush(app, body, null);
    expect(findMany).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it('does nothing for an unrelated branch', async () => {
    await triggerKnowledgeBasePush(app, { ...push, ref: 'refs/heads/feature' }, null);
    expect(start).not.toHaveBeenCalled();
  });
  it('surfaces a failed workflow start for the webhook caller to log', async () => {
    start.mockRejectedValueOnce(new Error('offline'));
    await expect(triggerKnowledgeBasePush(app, push, null)).rejects.toThrow('offline');
  });
});
