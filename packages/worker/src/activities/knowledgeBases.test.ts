import { isUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, build } = vi.hoisted(() => ({ build: vi.fn(), findMany: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { knowledgeBase: { findMany } } }));
vi.mock('../lib/knowledgeBaseIndex.js', () => ({ indexKnowledgeBaseSnapshot: build }));

import { getKnowledgeBasesForSync, indexKnowledgeBaseSnapshot } from './knowledgeBases.js';

beforeEach(() => {
  vi.clearAllMocks();
});
describe('knowledge base activities', () => {
  it('lists active git-backed bases in an explicitly cross-tenant sweep', async () => {
    findMany.mockImplementation(async () => {
      expect(isUnscoped('KnowledgeBase')).toBe(true);
      return [{ id: 'kb' }];
    });
    expect(await getKnowledgeBasesForSync()).toEqual(['kb']);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' },
      select: { id: true },
      where: { connection: { isActive: true, type: 'git_repo' }, status: 'OK' },
    });
  });
  it('returns no ids for an empty deployment', async () => {
    findMany.mockResolvedValue([]);
    expect(await getKnowledgeBasesForSync()).toEqual([]);
  });
  it('surfaces database failures', async () => {
    findMany.mockRejectedValue(new Error('offline'));
    await expect(getKnowledgeBasesForSync()).rejects.toThrow('offline');
  });
  it('keeps large file-status metadata out of Temporal activity results', async () => {
    build.mockResolvedValue({
      flaggedFiles: [{ path: 'large', reason: 'injection' }],
      id: 'snapshot',
      sha: 'sha',
    });
    expect(await indexKnowledgeBaseSnapshot('kb', 'sha')).toEqual({
      sha: 'sha',
      snapshotId: 'snapshot',
    });
    expect(build).toHaveBeenCalledWith('kb', 'sha');
  });
});
