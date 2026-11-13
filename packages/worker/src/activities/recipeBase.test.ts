import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueOrThrow, resolveBranchHead, resolveRef } = vi.hoisted(() => ({
  findUniqueOrThrow: vi.fn(),
  resolveBranchHead: vi.fn(),
  resolveRef: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { connection: { findUniqueOrThrow } } }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ resolveBranchHead, resolveRef }),
  toRepoRef: (repo: { id: string }) => ({ id: repo.id, scmProvider: 'github' }),
}));

import { pinRecipeBase } from './recipeBase.js';

const BASE = 'a'.repeat(40);
const request = { externalTicketId: 'CAMPAIGN-x', payload: {}, repoId: 'repo-1' } as never;

beforeEach(() => {
  vi.resetAllMocks();
  findUniqueOrThrow.mockResolvedValue({ defaultBranch: 'main', id: 'repo-1' });
  resolveBranchHead.mockImplementation(async (_repo: unknown, ref: string) =>
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
    expect(resolveBranchHead.mock.calls.map((c) => c[1])).toEqual(['auto/CAMPAIGN-x', 'main']);
  });

  it('refuses a work branch someone already pushed to the host', async () => {
    resolveBranchHead.mockImplementation(async (_repo: unknown, ref: string) =>
      ref === 'main' ? BASE : 'f'.repeat(40)
    );
    const pinned = await pinRecipeBase(request, 'auto/CAMPAIGN-x');
    expect(pinned).toMatchObject({ ok: false });
    expect(pinned.ok ? '' : pinned.reason).toMatch(
      /auto\/CAMPAIGN-x already exists on the host \(at ffffffffffff\)/
    );
  });

  it('takes the base the run names in its payload', async () => {
    resolveBranchHead.mockImplementation(async (_repo: unknown, ref: string) =>
      ref === 'release/2' ? BASE : null
    );
    await expect(
      pinRecipeBase({ ...(request as object), payload: { baseBranch: 'release/2' } } as never, 'b')
    ).resolves.toMatchObject({ baseBranch: 'release/2', baseSha: BASE });
  });

  it('fails when the base branch cannot be resolved, rather than guess one', async () => {
    resolveBranchHead.mockResolvedValue(null);
    await expect(pinRecipeBase(request, 'auto/CAMPAIGN-x')).rejects.toThrow(
      /could not resolve the base branch main/
    );
  });

  it('reads branch heads only: a tag named like a branch neither refuses nor pins', async () => {
    // A host where `repos.getCommit` would resolve these names through tags: a tag named like
    // the work branch, and a tag named like the base branch at another commit.
    const TAG = 't'.repeat(40);
    resolveRef.mockImplementation(async (_repo: unknown, ref: string) =>
      ref === 'auto/CAMPAIGN-x' || ref === 'main' ? TAG : null
    );
    await expect(pinRecipeBase(request, 'auto/CAMPAIGN-x')).resolves.toEqual({
      baseBranch: 'main',
      baseSha: BASE,
      ok: true,
    });
    expect(resolveRef).not.toHaveBeenCalled();
  });
});
