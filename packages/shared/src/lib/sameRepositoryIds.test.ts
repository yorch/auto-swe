import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import { sameRepositoryIds } from './sameRepositoryIds.js';

vi.mock('./systemConfig.js', () => ({
  resolveGitHubConfig: async () => ({ baseUrl: 'https://github.com' }),
}));

type Row = {
  id: string;
  githubUrl: string | null;
  organizationName: string | null;
  repoName: string | null;
};
const ME: Row = { githubUrl: null, id: 'me', organizationName: 'Acme', repoName: 'API' };

const findMany = vi.fn();
const findUnique = vi.fn();
const prisma = { connection: { findMany, findUnique } } as unknown as PrismaClient;

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue(ME);
});

describe('sameRepositoryIds', () => {
  it('includes rows that differ only in the casing of owner and name', async () => {
    findMany.mockResolvedValue([
      ME,
      { githubUrl: null, id: 'lower', organizationName: 'acme', repoName: 'api' },
    ]);
    await expect(sameRepositoryIds(prisma, 'me')).resolves.toEqual(['me', 'lower']);
  });

  it("treats an override spelling out the instance's host as the same host", async () => {
    findMany.mockResolvedValue([
      ME,
      { githubUrl: 'https://github.com', id: 'spelled', organizationName: 'acme', repoName: 'api' },
    ]);
    await expect(sameRepositoryIds(prisma, 'me')).resolves.toEqual(['me', 'spelled']);
  });

  it('keeps a repository on another host with the same owner and name foreign', async () => {
    findMany.mockResolvedValue([
      ME,
      { githubUrl: 'https://ghe.corp', id: 'ghe', organizationName: 'acme', repoName: 'api' },
    ]);
    await expect(sameRepositoryIds(prisma, 'me')).resolves.toEqual(['me']);
  });

  it('ignores a name that only matched as a wildcard or a prefix', async () => {
    findMany.mockResolvedValue([
      ME,
      { githubUrl: null, id: 'near', organizationName: 'acme', repoName: 'ap_' },
    ]);
    await expect(sameRepositoryIds(prisma, 'me')).resolves.toEqual(['me']);
  });

  it('is just the row itself when it has no repository coordinates', async () => {
    findUnique.mockResolvedValue({ ...ME, organizationName: null });
    await expect(sameRepositoryIds(prisma, 'me')).resolves.toEqual(['me']);
    expect(findMany).not.toHaveBeenCalled();
  });
});
