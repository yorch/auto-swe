import { createHash } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { OnboardingRequestSchema, renderOnboardingFiles } from '@auto-swe/shared/lib/onboardingPr';
import type {
  OnboardingPrInput,
  OnboardingPrResult,
} from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/execUtils.js';
import { withCoAuthorTrailer } from '../lib/gitIdentity.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { createWorkspace, shellQuote, type Workspace } from './workspace.js';

/**
 * Opens (or updates) the one pull request that adds a repository's `.auto-swe/` configuration
 * files. The files are the platform's own deterministic render of structured input — nothing an
 * agent wrote — and the activity never merges, never force-pushes, and never writes to the default
 * branch: a differing existing file is changed on the pull request's branch only.
 *
 * The branch is named after the content (`<prefix>/onboard-<hash>`), so a re-run of the same
 * request builds on that branch's tip and pushes a fast-forward. Failures that no retry can fix
 * are non-retryable `ONBOARDING_PR_REFUSED`; transient git and network errors propagate.
 */

export const ONBOARDING_PR_COMMIT_MESSAGE = 'chore: add auto-swe repository configuration';
export const ONBOARDING_PR_TITLE = ONBOARDING_PR_COMMIT_MESSAGE;

const PATH_RE = /^\.auto-swe\/[a-z-]+\.yml$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const MAX_FILE_BYTES = 256 * 1024;
const CONFIG_DIR = '.auto-swe';
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

const GIT =
  'GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git ' +
  '-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null ' +
  '-c core.autocrlf=false -c commit.gpgsign=false';

function refuse(message: string): never {
  throw ApplicationFailure.nonRetryable(message, 'ONBOARDING_PR_REFUSED');
}

/** Text that came from the repository, shortened and quoted so it is safe to put in a message. */
function shown(text: string | null): string {
  return JSON.stringify((text ?? '(none)').slice(0, 120));
}

/**
 * The branch name is predictable, so anyone with push access can seed it before we do. Before
 * building on an existing one, require that it holds nothing but this request's own files: a
 * pull request whose diff the platform describes as "adds config" must not carry anything else.
 *
 * Authorship is not verifiable here (git author and committer fields are free text that anyone
 * with push access can set), so it is not checked. Content is: only the paths this request
 * renders, only added or modified, never deleted, renamed or copied.
 */
async function vetExistingBranch(args: {
  allowedPaths: readonly string[];
  baseBranch: string;
  branch: string;
  openPr: boolean;
  repoRef: ReturnType<typeof toRepoRef>;
  scm: ReturnType<typeof getScmProvider>;
}): Promise<void> {
  const { allowedPaths, baseBranch, branch, repoRef, scm } = args;
  if (!args.openPr) {
    refuse(
      `The branch ${shown(branch)} already exists but has no open pull request (it was closed or ` +
        'merged). Delete the branch on the repository and ask again; the platform does not ' +
        'reuse or overwrite it.'
    );
  }
  const comparison = await scm.compareCommits(repoRef, baseBranch, branch);
  if (comparison.paths === null || !comparison.files) {
    refuse(`The branch ${shown(branch)} changes too many files to verify; delete it and ask again`);
  }
  for (const file of comparison.files) {
    if (!allowedPaths.includes(file.path)) {
      refuse(
        `The branch ${shown(branch)} changes ${shown(file.path)}, which this pull request may ` +
          'not touch; delete the branch and ask again'
      );
    }
    if (file.previousPath !== null || (file.status !== 'added' && file.status !== 'modified')) {
      refuse(
        `The branch ${shown(branch)} ${shown(file.status)} ${shown(file.path)}; only adding or ` +
          'modifying a file is allowed. Delete the branch and ask again'
      );
    }
  }
}

/**
 * What the pull request will contain: the three-dot diff from the default branch's tip to `HEAD`
 * must list exactly `expected`, each added or modified. A rename, deletion, copy, type change or
 * extra path anywhere in the branch is refused before anything is pushed.
 */
async function assertDiffIsExactly(ws: Workspace, expected: readonly string[]): Promise<void> {
  const out = await ws.execCapture(`${GIT} diff --name-status FETCH_HEAD...HEAD`);
  if (out.exitCode !== 0) {
    throw new Error('git diff failed');
  }
  const seen: string[] = [];
  for (const line of out.stdout.split('\n').filter((l) => l.length > 0)) {
    const [status, ...rest] = line.split('\t');
    if ((status !== 'A' && status !== 'M') || rest.length !== 1 || rest[0] === undefined) {
      refuse(`The branch would change ${shown(line)}; only added or modified files are allowed`);
    }
    seen.push(rest[0]);
  }
  if (seen.length !== expected.length || !expected.every((p) => seen.includes(p))) {
    refuse(
      `The branch would change ${shown(seen.join(', '))}, not exactly ${shown(expected.join(', '))}`
    );
  }
}

/**
 * The two files go in `.auto-swe/`. Refuse when that directory or either file is, in the tree we
 * are about to commit on, a symlink, a submodule or the wrong kind of entry, or is a symlink on
 * disk: `cat >` would follow it out of the repository and `git add` would record a link.
 */
async function assertSafeLayout(ws: Workspace, paths: readonly string[]): Promise<void> {
  const listing = await ws.execCapture(
    `${GIT} ls-tree HEAD -- ${[CONFIG_DIR, ...paths].map(shellQuote).join(' ')}`
  );
  if (listing.exitCode !== 0) {
    throw new Error('git ls-tree failed');
  }
  const modes = new Map<string, string>();
  for (const line of listing.stdout.split('\n')) {
    const match = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      modes.set(match[2], match[1]);
    }
  }
  const dirMode = modes.get(CONFIG_DIR);
  if (dirMode !== undefined && dirMode !== '040000') {
    refuse(`${CONFIG_DIR} exists in the repository but is not a directory (mode ${dirMode})`);
  }
  for (const path of paths) {
    const mode = modes.get(path);
    if (mode !== undefined && !REGULAR_FILE_MODES.has(mode)) {
      refuse(`${path} exists in the repository but is not a regular file (mode ${mode})`);
    }
  }
  const link = await ws.execCapture(`test -L ${shellQuote(CONFIG_DIR)}`);
  if (link.exitCode === 0) {
    refuse(`${CONFIG_DIR} is a symbolic link in the workspace`);
  }
}

/** The first 16 hex digits of a sha256 over the sorted `path\0content` pairs (as the gateway). */
export function contentHashOf(files: readonly { path: string; content: string }[]): string {
  const canonical = files
    .map((f) => `${f.path}\0${f.content}`)
    .sort()
    .join('\0\0');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function onboardingPrBody(paths: readonly string[]): string {
  return [
    'This pull request was proposed from the auto-swe repository settings. It only adds or updates',
    'configuration files:',
    '',
    ...paths.map((p) => `- \`${p}\``),
    '',
    '**Merging this pull request does not enable anything.** It does not install tools and it does',
    'not change how pull requests are evaluated. An administrator still has to turn on',
    '`toolsFileEnabled` for the repository before the tools file is read.',
    '',
    'A person reviews and merges this pull request; the platform never merges it.',
  ].join('\n');
}

function redactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const values = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return (text) => values.reduce((acc, v) => acc.split(v).join('***'), text);
}

async function recordEvent(
  input: OnboardingPrInput,
  outcome: { result?: OnboardingPrResult; error?: string }
): Promise<void> {
  try {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({
      ...(outcome.error ? { error: outcome.error } : {}),
      name: 'onboarding_pr.opened',
      outputJson: {
        changed: outcome.result?.changed ?? [],
        files: input.files.map((f) => f.kind),
        proposedById: input.proposedById,
        pullRequestNumber: outcome.result?.pullRequestNumber ?? null,
        skipped: outcome.result?.skipped ?? [],
        status: outcome.result?.status ?? 'failed',
      },
    });
    await persistActivityTrace(tracer, 'onboardingPr');
  } catch (err) {
    console.warn(
      `[onboarding-pr] onboarding_pr.opened not recorded: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function openOnboardingPr(input: OnboardingPrInput): Promise<OnboardingPrResult> {
  let result: OnboardingPrResult | undefined;
  let failure: string | undefined;
  try {
    result = await run(input);
    return result;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await recordEvent(input, {
      ...(result ? { result } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
    });
  }
}

async function run(input: OnboardingPrInput): Promise<OnboardingPrResult> {
  const parsed = OnboardingRequestSchema.safeParse({ files: input.files });
  if (!parsed.success) {
    refuse('The onboarding request is not valid');
  }
  let rendered: { path: string; content: string }[];
  try {
    rendered = renderOnboardingFiles(parsed.data);
  } catch (err) {
    refuse(
      `The onboarding files cannot be rendered: ${shown(err instanceof Error ? err.message : null)}`
    );
  }
  if (!HASH_RE.test(input.contentHash) || contentHashOf(rendered) !== input.contentHash) {
    refuse('The onboarding content does not match its hash');
  }
  for (const file of rendered) {
    if (!PATH_RE.test(file.path) || Buffer.byteLength(file.content) > MAX_FILE_BYTES) {
      refuse('The onboarding request names a file that cannot be proposed');
    }
  }

  const repo = await prisma.connection.findUnique({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: input.connectionId },
  });
  if (repo?.type !== 'git_repo' || !repo.isActive) {
    refuse('The repository was not found or is not active');
  }
  if (!(await repositoryHostsAllowed(repo)).ok) {
    refuse('The repository host is not approved for platform credentials');
  }

  const { branchPrefix } = await resolveWorkflowDefaults();
  const branch = `${branchPrefix}/onboard-${input.contentHash}`;
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    refuse('The onboarding branch name is not valid');
  }

  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const baseBranch = repo.defaultBranch;
  const prior = await scm.findBranchWork(repoRef, branch, baseBranch);
  if (prior.branchExists) {
    await vetExistingBranch({
      allowedPaths: rendered.map((f) => f.path),
      baseBranch,
      branch,
      openPr: prior.openPr !== null,
      repoRef,
      scm,
    });
  }
  const { authedCloneUrl, token } = await scm.cloneCredentials(repoRef);
  const redact = redactor([
    token,
    authedCloneUrl,
    Buffer.from(`x-access-token:${token}`).toString('base64'),
  ]);

  throwIfActivityCancelled();
  let ws: Workspace | undefined;
  try {
    // The clone is the existing onboarding branch when there is one, so the push below is a
    // fast-forward; otherwise a new branch cut from the default branch. No agent, no tools.
    ws = await createWorkspace(
      authedCloneUrl,
      branch,
      baseBranch,
      executorImageFor(repo),
      undefined,
      prior.branchExists,
      { teamId: repo.teamId }
    );
    return await propose(ws, {
      baseBranch,
      branch,
      openPr: prior.openPr,
      rendered,
      repoRef,
      scm,
    });
  } catch (err) {
    if (err instanceof ApplicationFailure) {
      throw err;
    }
    // Never let a credential or clone URL travel in a failure message.
    const wrapped = new Error(redact(err instanceof Error ? err.message : String(err)));
    wrapped.name = err instanceof Error ? err.name : 'Error';
    throw wrapped;
  } finally {
    if (ws) {
      await ws.destroy().catch(() => undefined);
    }
  }
}

async function propose(
  ws: Workspace,
  args: {
    baseBranch: string;
    branch: string;
    openPr: { prNumber: number; prUrl: string } | null;
    rendered: { path: string; content: string }[];
    repoRef: ReturnType<typeof toRepoRef>;
    scm: ReturnType<typeof getScmProvider>;
  }
): Promise<OnboardingPrResult> {
  const paths = args.rendered.map((f) => f.path);
  // The workspace is the onboarding branch when it exists, so `HEAD` is not the default branch.
  // Identical-ness is judged against the default branch's tip, the thing a merge would change.
  await ws.gitAuthed(`fetch --no-tags origin ${shellQuote(`refs/heads/${args.baseBranch}`)}`);
  await assertSafeLayout(ws, paths);

  const changed: string[] = [];
  const skipped: string[] = [];
  const toWrite: { path: string; content: string }[] = [];
  for (const file of args.rendered) {
    const onDefault = await ws.execCapture(`${GIT} show ${shellQuote(`FETCH_HEAD:${file.path}`)}`);
    if (onDefault.exitCode === 0 && onDefault.stdout === file.content) {
      skipped.push(file.path);
      continue;
    }
    changed.push(file.path);
    const onBranch = await ws.execCapture(`${GIT} show ${shellQuote(`HEAD:${file.path}`)}`);
    if (!(onBranch.exitCode === 0 && onBranch.stdout === file.content)) {
      toWrite.push(file);
    }
  }
  if (toWrite.length === 0) {
    await assertDiffIsExactly(ws, changed);
    // Everything is already on the default branch, or already on the open pull request's branch.
    return {
      changed,
      ...(args.openPr
        ? { pullRequestNumber: args.openPr.prNumber, pullRequestUrl: args.openPr.prUrl }
        : {}),
      skipped,
      status: 'nothing_to_do',
    };
  }
  for (const file of toWrite) {
    await ws.exec(`mkdir -p ${shellQuote(CONFIG_DIR)}`);
    await ws.execStdin(`cat > ${shellQuote(file.path)}`, file.content);
  }

  // `-f`: the repository may git-ignore `.auto-swe/`, and the proposal is the point of the run.
  await ws.exec(`${GIT} add -f -- ${toWrite.map((f) => shellQuote(f.path)).join(' ')}`);
  await ws.exec(
    `${GIT} commit -q --no-verify -m ${shellQuote(withCoAuthorTrailer(ONBOARDING_PR_COMMIT_MESSAGE, ws.gitIdentity))}`
  );
  await assertDiffIsExactly(ws, changed);
  const sha = (await ws.exec(`${GIT} rev-parse HEAD`)).trim();
  if (!SHA_RE.test(sha)) {
    throw new Error('unexpected commit id');
  }
  throwIfActivityCancelled();
  // A plain refspec, never `+` and never `--force`: the branch is ours and only moves forward.
  await ws.gitAuthed(`push origin ${shellQuote(`${sha}:refs/heads/${args.branch}`)}`);

  const pr = await args.scm.createOrUpdatePullRequest({
    baseBranch: args.baseBranch,
    body: onboardingPrBody(changed),
    headBranch: args.branch,
    repo: args.repoRef,
    reuseExisting: true,
    title: ONBOARDING_PR_TITLE,
    updateExisting: true,
  });
  return {
    changed,
    pullRequestNumber: pr.prNumber,
    pullRequestUrl: pr.prUrl,
    skipped,
    status: args.openPr ? 'updated' : 'opened',
  };
}
