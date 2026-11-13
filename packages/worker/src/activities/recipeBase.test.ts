import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueOrThrow, resolveRef } = vi.hoisted(() => ({
  findUniqueOrThrow: vi.fn(),
  resolveRef: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { connection: { findUniqueOrThrow } } }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ resolveRef }),
  toRepoRef: (repo: { id: string }) => ({ id: repo.id, scmProvider: 'github' }),
}));

import { pinRecipeBase } from './recipeBase.js';

const BASE = 'a'.repeat(40);
const request = { externalTicketId: 'CAMPAIGN-x', payload: {}, repoId: 'repo-1' } as never;

beforeEach(() => {
  vi.resetAllMocks();
  findUniqueOrThrow.mockResolvedValue({ defaultBranch: 'main', id: 'repo-1' });
  resolveRef.mockImplementation(async (_repo: unknown, ref: string) =>
    ref === 'main' ? BASE : null
  );
});

describe('pinRecipeBase', () => {
  it('records the base branch tip, by sha, when the work branch does not exist yet', async () => {
    await expect(pinRecipeBase(request, 'auto/CAMPAIGN-x')).resolves.toEqual({
      baseBranch: 'main',
      baseSha: BASE,
      ok: true,
    });
    expect(resolveRef.mock.calls.map((c) => c[1])).toEqual(['auto/CAMPAIGN-x', 'main']);
  });

  it('refuses a work branch someone already pushed to the host', async () => {
    resolveRef.mockImplementation(async (_repo: unknown, ref: string) =>
      ref === 'main' ? BASE : 'f'.repeat(40)
    );
    const pinned = await pinRecipeBase(request, 'auto/CAMPAIGN-x');
    expect(pinned).toMatchObject({ ok: false });
    expect(pinned.ok ? '' : pinned.reason).toMatch(
      /auto\/CAMPAIGN-x already exists on the host \(at ffffffffffff\)/
    );
  });

  it('takes the base the run names in its payload', async () => {
    resolveRef.mockImplementation(async (_repo: unknown, ref: string) =>
      ref === 'release/2' ? BASE : null
    );
    await expect(
      pinRecipeBase({ ...(request as object), payload: { baseBranch: 'release/2' } } as never, 'b')
    ).resolves.toMatchObject({ baseBranch: 'release/2', baseSha: BASE });
  });

  it('fails when the base branch cannot be resolved, rather than guess one', async () => {
    resolveRef.mockResolvedValue(null);
    await expect(pinRecipeBase(request, 'auto/CAMPAIGN-x')).rejects.toThrow(
      /could not resolve the base branch main/
    );
  });
});
