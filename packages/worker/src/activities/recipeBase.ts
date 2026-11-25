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
 *  - the base branch's tip is resolved on the host, by sha, as the exact branch head (a tag
 *    named like the branch does not stand in for it); and
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

  // Branch heads only: a tag or a sha named like either branch must not stand in for it.
  const existing = await provider.resolveBranchHead(repoRef, branch);
  if (existing !== null) {
    return {
      ok: false,
      reason: `the work branch ${branch} already exists on the host (at ${existing.slice(0, 12)}); the recipe builds only on a branch it creates, so it was not run`,
    };
  }
  const baseSha = await provider.resolveBranchHead(repoRef, baseBranch);
  if (baseSha === null || !SHA.test(baseSha)) {
    throw new Error(`could not resolve the base branch ${baseBranch} on the host`);
  }
  return { baseBranch, baseSha, ok: true };
}

/**
 * The sha the repository's base branch points at on the host right now, resolved the way
 * {@link pinRecipeBase} resolves it (a branch head, never a tag) and the way a campaign check clones
 * it (the repository's default branch), without cloning. Bounded by `timeoutMs`, and fail-closed:
 * any failure, timeout or malformed answer is `null`, which the caller reads as "not known", never
 * as "unchanged".
 */
export async function resolveCheckBaseTip(
  repoId: string,
  timeoutMs = 15_000
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = (async () => {
      const repo = await prisma.connection.findUniqueOrThrow({
        include: { installation: { select: { host: true, installationId: true } } },
        where: { id: repoId },
      });
      const repoRef = toRepoRef(repo);
      const baseBranch = await resolveRequestBaseBranch({ payload: {} }, repo);
      const sha = await getScmProvider(repoRef).resolveBranchHead(repoRef, baseBranch);
      return sha !== null && SHA.test(sha) ? sha : null;
    })();
    lookup.catch(() => undefined);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
