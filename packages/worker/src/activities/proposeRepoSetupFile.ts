import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { parseRepoSetup, REPO_SETUP_FILE, repoSetupToYaml } from '@auto-swe/shared/lib/repoSetup';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { RepoSetupFileProposal } from '@auto-swe/shared/types/api';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

export interface ProposeRepoSetupFileInput {
  connectionId: string;
  /** The definition to commit; validated again here against the shared schema. */
  setup: unknown;
}

export type ProposeRepoSetupFileResult = RepoSetupFileProposal;

const PR_BODY = [
  `Adds \`${REPO_SETUP_FILE}\`, the workspace setup auto-swe runs in every workspace of this`,
  'repository after the checkout: submodules, LFS, install steps and a dependency cache.',
  '',
  "A repository's own setup field in auto-swe, when set, takes precedence over this file.",
].join('\n');

/**
 * Open a pull request that adds `.auto-swe/setup.yml` to a repository's default branch, written
 * from `setup`, through the host's API on a fresh branch. Refuses when the default branch already
 * has the file: this only ever adds one, never edits it.
 */
export async function proposeRepoSetupFile(
  input: ProposeRepoSetupFileInput
): Promise<ProposeRepoSetupFileResult> {
  const parsed = parseRepoSetup(input.setup);
  if (!parsed.ok) {
    return { detail: parsed.error, ok: false, reason: 'invalid' };
  }
  const row = await prisma.connection.findUnique({
    include: { installation: true },
    where: { id: input.connectionId },
  });
  if (row?.type !== 'git_repo') {
    return { detail: 'repository not found', ok: false, reason: 'not_found' };
  }
  const repo = toRepoRef(row);
  const provider = getScmProvider(repo);
  const base = row.defaultBranch || (await provider.defaultBranch(repo));
  const baseSha = await provider.resolveRef(repo, base);
  if (!baseSha) {
    return { detail: `branch ${base} not found`, ok: false, reason: 'no_base' };
  }
  if ((await provider.fetchFileContent(repo, REPO_SETUP_FILE, baseSha)) !== null) {
    return {
      detail: `${base} already has ${REPO_SETUP_FILE}`,
      ok: false,
      reason: 'exists',
    };
  }
  const { branchPrefix } = await resolveWorkflowDefaults();
  const branch = `${branchPrefix}/setup-yml-${crypto.randomBytes(4).toString('hex')}`;
  await provider.createBranch(repo, branch, baseSha);
  await provider.createFile(repo, {
    branch,
    content: repoSetupToYaml(parsed.setup),
    message: `chore: add ${REPO_SETUP_FILE}`,
    path: REPO_SETUP_FILE,
  });
  const pr = await provider.createOrUpdatePullRequest({
    baseBranch: base,
    body: PR_BODY,
    headBranch: branch,
    repo,
    title: `chore: add ${REPO_SETUP_FILE}`,
  });
  return { branch, ok: true, prNumber: pr.prNumber, prUrl: pr.prUrl };
}
