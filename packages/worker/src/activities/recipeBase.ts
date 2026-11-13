/**
 * The base a campaign recipe's change is measured from, pinned before the recipe touches the
 * repository.
 *
 * Protected verification restores the tests to `CodeResult.baseSha`, so that commit must be one
 * the platform chose, not one anyone with push access to the repository could choose. The shell
 * step clones the work branch when it already exists on the host, so a branch someone pushed ahead
 * of the campaign (with weakened tests on it) would otherwise become the recipe's parent, and the
 * restore would put back the weakened tests. So, before the recipe runs:
 *
 *  - the base branch's tip is resolved on the host, by sha; and
 *  - a work branch that already exists on the host is refused: the recipe step is the first to
 *    touch the branch, and a branch it did not create is not one it builds on.
 *
 * After the recipe pushed, its commit's first parent must be that sha (`applyRecipe` checks), which
 * also catches a branch created between this check and the clone.
 */
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

/** The pinned base, or why the recipe may not run on this repository. */
export type RecipeBase =
  | { ok: true; baseBranch: string; baseSha: string }
  | { ok: false; reason: string };

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export async function pinRecipeBase(request: RepoWorkRequest, branch: string): Promise<RecipeBase> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: requireRepoId(request, 'applyRecipe') },
  });
  const repoRef = toRepoRef(repo);
  const provider = getScmProvider(repoRef);
  const baseBranch = await resolveRequestBaseBranch(request, repo);

  const existing = await provider.resolveRef(repoRef, branch);
  if (existing !== null) {
    return {
      ok: false,
      reason: `the work branch ${branch} already exists on the host (at ${existing.slice(0, 12)}); the recipe builds only on a branch it creates, so it was not run`,
    };
  }
  const baseSha = await provider.resolveRef(repoRef, baseBranch);
  if (baseSha === null || !SHA.test(baseSha)) {
    throw new Error(`could not resolve the base branch ${baseBranch} on the host`);
  }
  return { baseBranch, baseSha, ok: true };
}
