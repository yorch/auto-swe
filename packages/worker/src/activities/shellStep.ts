/**
 * Phase-6 shell-step activity.
 *
 * Runs a user-authored command inside a locked-down ephemeral container
 * (see packages/worker/src/lib/ephemeralContainer.ts) with the work-request's
 * branch checked out into a fresh Docker volume that's bind-mounted at
 * `/workspace`. After the command exits, any uncommitted changes in the
 * volume are auto-committed and pushed so downstream agents/gates see the
 * effect.
 *
 * Threat-model recap (vs. the agent workspace):
 *   - Image must be on the team's allowlist (built-in defaults + Team additions).
 *     Rejected at workflow start.
 *   - No Docker socket mount, no privileges, CPU/memory/PID caps, --read-only
 *     root filesystem, /tmp on a small tmpfs.
 *   - `--network=none` by default. Authors opt in to outbound via `network: 'egress'`.
 *   - No SCM credential at rest in the workspace volume: `origin` is scrubbed
 *     immediately after clone and the finalize push authenticates per-call via
 *     `http.extraheader`. An author command therefore cannot read the token,
 *     and equally cannot run its own authenticated `git fetch`/`push` — see
 *     `cloneIntoVolume`.
 *
 * Return shape mirrors the phase-2 GateResult so the interpreter's
 * gate-failure path (`passed === false` → onFail policy) fires uniformly for
 * both quality gates and shell steps.
 */

import crypto from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { assertShellImageAllowed, ShellImageNotAllowedError } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { currentWorkflowId, currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { execShellAsync } from '../lib/execUtils.js';
import { redactExecError, redactToken } from '../lib/redactToken.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { recordLessonBackground } from './commitToMemory.js';
import { truncate } from './qualityGates.js';
import { gitWithAuthHeader, shellQuote, splitCloneCredential } from './workspace.js';

export interface ShellStepInput {
  request: RepoWorkRequest;
  /** Docker image (must be on allowlist; validated at runtime too). */
  image: string;
  /** Shell command. Required. */
  command: string;
  network?: 'none' | 'egress';
  memory?: string;
  cpus?: number;
  timeoutMs?: number;
  /** Override the branch checked out into the workspace. Defaults to the work-request branch. */
  branch?: string;
}

export interface ShellStepResult {
  passed: boolean;
  summary: string;
  exitCode: number;
  signal?: string;
  artifactId?: string;
  /** SHA of the auto-commit, if any changes were made. */
  committedSha?: string;
  /** Files touched relative to the prior HEAD. Empty when the command made no changes. */
  filesChanged: string[];
}

// Tiny (~5MB) helper image with git built-in, used by the prep + finalize
// phases. A registry setting rather than a constant so a deployment can pin a
// digest instead of tracking the upstream `latest` tag.
//
// Resolved ONCE at the top of the step and threaded down, deliberately: the
// finalize path's errors are swallowed and reported as "command passed but the
// push failed", so a config-resolution failure in there would surface as a
// successful step whose changes were silently never committed.
async function gitHelperImage(): Promise<string> {
  return resolveSetting('workspace.gitHelperImage', await currentRequestContext());
}

async function runDocker(args: string[], tokenForRedact?: string | null): Promise<string> {
  // We shell-quote each arg before joining into a single shell command. The
  // inputs to this helper are either hard-coded literals or identifiers that
  // have already been validated upstream (volume names, images checked
  // against DOCKER_IMAGE_REF_RE, branch names quoted by the caller) — never
  // raw user input from a spec.
  const quoted = args.map(shellQuote).join(' ');
  try {
    return await execShellAsync(`docker ${quoted}`, { heartbeatLabel: 'shell-step: docker' });
  } catch (err) {
    // `runDocker` invokes `git clone` with the token embedded in the URL (see
    // `loadRepoMeta`), and `promisify(exec)` throws with the full command in
    // `error.message` / `.stdout` / `.stderr` / `.cmd`. Without this, a failed
    // clone would leak the token into the Temporal workflow history.
    redactExecError(err, [tokenForRedact]);
    throw err;
  }
}

async function safeRunDocker(args: string[]): Promise<void> {
  try {
    await runDocker(args);
  } catch {
    /* best-effort */
  }
}

interface RepoMeta {
  /** Credential-embedded clone URL from ScmProvider.cloneCredentials. */
  cloneUrl: string;
  /**
   * `cloneUrl` with the credential stripped — what `origin` is reset to right
   * after clone, so the token never sits at rest in the workspace volume the
   * author-supplied command can read.
   */
  cleanUrl: string;
  /**
   * `AUTHORIZATION: basic …` header used to authenticate the finalize push via
   * `git -c http.extraheader`, instead of a credential-bearing `origin`.
   * Undefined when the provider handed back an unauthenticated URL.
   */
  gitAuthHeader?: string;
  defaultBranch: string;
  teamId: string;
  teamAllowlist: string[];
  teamEgressAllowlist: string[];
  /** The resolved token — kept alongside cloneUrl so error-path redaction works
   * even when no GITHUB_TOKEN env var is set (DB-only token configuration). */
  token: string;
}

async function loadRepoMeta(request: RepoWorkRequest): Promise<RepoMeta> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { team: { select: { egressAllowlist: true, id: true, shellImageAllowlist: true } } },
    where: { id: requireRepoId(request, 'shell') },
  });
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl, token } = await getScmProvider(repoRef).cloneCredentials(repoRef);
  // Shared with the agent workspace (`activities/workspace.ts`): split the
  // credential out of the clone URL so it can be injected per network call
  // rather than persisted in `.git/config`.
  const { cleanUrl, gitAuthHeader } = splitCloneCredential(authedCloneUrl);
  return {
    cleanUrl,
    cloneUrl: authedCloneUrl,
    defaultBranch: repo.defaultBranch,
    ...(gitAuthHeader ? { gitAuthHeader } : {}),
    teamAllowlist: (repo.team?.shellImageAllowlist as string[] | null) ?? [],
    teamEgressAllowlist: (repo.team?.egressAllowlist as string[] | null) ?? [],
    teamId: repo.team?.id ?? '',
    token,
  };
}

/**
 * Clone the branch into the given volume. Falls back to the default branch
 * *only* when git reports the branch doesn't exist remotely (e.g. shell step
 * runs before the implementer's first push). Auth / network / docker
 * failures are surfaced unchanged so they're not masked by a confusing
 * default-branch retry. Caller owns volume lifecycle.
 *
 * The credential is scrubbed out of `origin` in the same `sh -c` script as the
 * clone (same approach as `createWorkspace` in `workspace.ts`): this volume is
 * bind-mounted into the container that runs the *author-supplied* command with
 * `/workspace/repo` as cwd, so a token baked into `.git/config` would be live
 * data inside the sandbox — readable with `cat .git/config` or `git remote -v`
 * and, on a `network: 'egress'` step, exfiltratable. Output redaction cannot
 * contain that: `redactToken` matches the exact substring, so any transform
 * (`base64`, `rev`, `tr`, `fold`) defeats it. Removing the credential at rest
 * is the actual fix; the redaction below it stays as defense in depth.
 *
 * DELIBERATE BEHAVIOR CHANGE: with `origin` scrubbed, an author command doing
 * its own `git fetch` / `git pull` / `git push` against a private repo now
 * fails to authenticate. That is intended — an author-supplied shell command
 * should not hold the org's push credential. The supported way to persist work
 * is to leave changes in the working tree: `finalizeWorkspaceVolume` commits
 * and pushes them, authenticating per-call via `http.extraheader`.
 */
async function cloneIntoVolume(
  volumeName: string,
  meta: RepoMeta,
  branch: string,
  image: string
): Promise<void> {
  const tryClone = (refspec: string): Promise<string> =>
    runDocker(
      [
        'run',
        '--rm',
        '-v',
        `${volumeName}:/workspace:rw`,
        '--entrypoint',
        'sh',
        image,
        '-c',
        // Every interpolated value stays `shellQuote`d — this string is the
        // injection boundary for the branch name and the remote URL.
        `git clone --depth=50 -b ${shellQuote(refspec)} ${shellQuote(meta.cloneUrl)} /workspace/repo && cd /workspace/repo && git remote set-url origin ${shellQuote(meta.cleanUrl)} && git config user.name 'auto-swe' && git config user.email 'auto-swe@localhost'`,
      ],
      meta.token
    );
  try {
    await tryClone(branch);
  } catch (err) {
    if (!isBranchNotFoundError(err)) {
      throw err;
    }
    await tryClone(meta.defaultBranch);
  }
}

/**
 * Recognize git's "branch doesn't exist" stderr. git uses different phrasings
 * across versions: "Remote branch X not found in upstream origin",
 * "fatal: couldn't find remote ref refs/heads/X", and "warning: Could not
 * find remote branch X to clone".
 */
function isBranchNotFoundError(err: unknown): boolean {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const haystack = [e.stderr, e.stdout, e.message]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
  return (
    /Remote branch .* not found/i.test(haystack) ||
    /couldn't find remote ref/i.test(haystack) ||
    /Could not find remote branch/i.test(haystack)
  );
}

interface FinalizeResult {
  committedSha?: string;
  filesChanged: string[];
}

/**
 * If the shell command modified the working tree, commit and push the result
 * back to origin on the same branch. Returns the auto-commit SHA + the list
 * of changed files. Skips silently when no changes are present.
 *
 * This runs in a *separate* container from the author's command, after it has
 * exited, so it is the only place the credential is legitimately needed. It is
 * injected for the push call alone via `git -c http.extraheader` (shared with
 * the agent workspace's `gitAuthed`), because `origin` was scrubbed by
 * `cloneIntoVolume` and no longer carries it.
 */
async function finalizeWorkspaceVolume(
  volumeName: string,
  branch: string,
  commandSummary: string,
  image: string,
  token: string,
  gitAuthHeader?: string
): Promise<FinalizeResult> {
  const script = [
    'set -e',
    'cd /workspace/repo',
    'if [ -z "$(git status --porcelain)" ]; then',
    '  echo NO_CHANGES',
    '  exit 0',
    'fi',
    'git add -A',
    `git commit -m ${shellQuote(`auto: shell step ${commandSummary}`)}`,
    // `gitWithAuthHeader` shell-quotes the header; the branch is quoted here.
    gitWithAuthHeader(`push origin HEAD:${shellQuote(branch)}`, gitAuthHeader),
    'git rev-parse HEAD',
    'git diff --name-only HEAD~1 HEAD',
  ].join('\n');
  // `git push` failures can still echo credential material (e.g. a git build
  // that logs the extraheader, or an operator-supplied URL we failed to
  // parse) — pass the token through so `runDocker`'s catch redacts it before
  // it ever reaches the caller. Defense in depth on top of the scrub.
  const out = await runDocker(
    ['run', '--rm', '-v', `${volumeName}:/workspace:rw`, '--entrypoint', 'sh', image, '-c', script],
    token
  );
  if (out.includes('NO_CHANGES')) {
    return { filesChanged: [] };
  }
  const lines = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // After our script: last 1 line is the diff list (may be empty), preceded
  // by the rev-parse HEAD line.
  const sha = lines.find((l) => /^[0-9a-f]{7,40}$/.test(l));
  const files = lines.filter((l) => !/^[0-9a-f]{7,40}$/.test(l) && l !== 'NO_CHANGES');
  return {
    filesChanged: files,
    ...(sha ? { committedSha: sha } : {}),
  };
}

/**
 * Run a phase-6 shell step. Caller (the workflow dispatcher) is expected to
 * have validated the image at template-save time, but we re-check here so a
 * stale spec / corrupted DB row can't silently bypass the allowlist.
 */
export async function runShellStep(input: ShellStepInput): Promise<ShellStepResult> {
  const meta = await loadRepoMeta(input.request);

  // Defense in depth: re-validate against the team's current allowlist.
  try {
    assertShellImageAllowed(input.image, meta.teamAllowlist);
  } catch (err) {
    if (err instanceof ShellImageNotAllowedError) {
      return {
        exitCode: 126, // POSIX "command invoked cannot execute"
        filesChanged: [],
        passed: false,
        summary: err.message,
      };
    }
    throw err;
  }

  const { branchPrefix } = await resolveWorkflowDefaults();
  const branch = input.branch ?? `${branchPrefix}/${input.request.externalTicketId}`;
  const helperImage = await gitHelperImage();

  const volumeName = `shellvol-${crypto.randomBytes(8).toString('hex')}`;
  await runDocker(['volume', 'create', volumeName]);
  try {
    heartbeat('shell-step: cloning branch into workspace volume');
    await cloneIntoVolume(volumeName, meta, branch, helperImage);

    heartbeat('shell-step: running command');
    const effectiveEgressAllowlist = meta.teamEgressAllowlist;
    const result = await runEphemeralContainer({
      command: input.command,
      cpus: input.cpus,
      egressAllowlist: effectiveEgressAllowlist,
      image: input.image,
      memory: input.memory,
      network: input.network ?? 'none',
      timeoutMs: input.timeoutMs,
      workdir: '/workspace/repo',
      workspaceMount: volumeName,
    });

    // Defense in depth. `cloneIntoVolume` now scrubs the credential out of
    // `origin`, so `/workspace/repo/.git/config` no longer holds it and a
    // `git remote -v` / `cat .git/config` from the author's command has
    // nothing to print. This redaction stays anyway: it costs nothing, and it
    // still catches a token that reaches stdout by some other route (an
    // operator-supplied clone URL shape `splitCloneCredential` failed to
    // parse, or a future caller that reintroduces one). Every downstream use
    // (artifact body, truncated summary tail) reads from these redacted
    // copies, never from `result.stdout`/`result.stderr` directly.
    const redactedStdout = redactToken(result.stdout, meta.token);
    const redactedStderr = redactToken(result.stderr, meta.token);

    const fullLog = `$ ${input.command}\n--- stdout ---\n${redactedStdout}\n--- stderr ---\n${redactedStderr}`;
    const runId = await currentWorkflowRunId();
    const artifact = await putArtifact({
      body: fullLog,
      contentType: 'text/plain; charset=utf-8',
      kind: 'shell.step',
      runId,
    }).catch(() => null);

    const passed = result.exitCode === 0 && !result.signal;

    let finalize: FinalizeResult = { filesChanged: [] };
    let pushError: string | undefined;
    if (passed) {
      heartbeat('shell-step: finalizing workspace');
      try {
        finalize = await finalizeWorkspaceVolume(
          volumeName,
          branch,
          input.command.slice(0, 80),
          helperImage,
          meta.token,
          meta.gitAuthHeader
        );
      } catch (err) {
        // A push failure shouldn't mask a successful command run, but the
        // caller needs to know changes weren't persisted. Surface the
        // (token-redacted) error in the summary alongside passed=true.
        const e = err as { stderr?: unknown; message?: unknown };
        const raw =
          (typeof e.stderr === 'string' && e.stderr) ||
          (typeof e.message === 'string' && e.message) ||
          String(err);
        pushError = redactToken(raw, meta.token).slice(0, 500);
      }
    }

    // Redact before truncating, not after: a token straddling the truncation
    // cut would otherwise leave an unredacted fragment in the summary (and in
    // Temporal history) because the split-token halves no longer match the
    // full token string.
    const tail = truncate(`${redactedStderr || redactedStdout}`.trim(), 4000);
    const passSummary = pushError
      ? `shell step ran (exit 0) but git push failed — changes NOT persisted: ${pushError}`
      : `shell step passed (exit 0; ${finalize.filesChanged.length} files changed)`;

    // Phase-8 memory hook: a shell step that actually changed files + pushed
    // is worth remembering — usually a codemod or auto-fix the team will want
    // future runs to know about. Fire-and-forget; never fails the step.
    if (passed && !pushError && finalize.filesChanged.length > 0) {
      // 5-second cap so a slow embedding provider can't extend the shell-step
      // activity past its timeout after the real work has already succeeded.
      await recordLessonBackground({
        lessonSummary: `Shell step modified ${finalize.filesChanged.length} file(s) on branch ${branch}: ${input.command.slice(0, 200)}`,
        metadata: {
          branch,
          ...(finalize.committedSha ? { committedSha: finalize.committedSha } : {}),
          filesChanged: finalize.filesChanged.slice(0, 50),
          image: input.image,
        },
        rationale: `Shell step succeeded (exit 0) and committed working-tree changes.`,
        repoId: requireRepoId(input.request, 'shell'),
        temporalWorkflowId: currentWorkflowId(),
      });
    }

    const summary = passed
      ? passSummary
      : `shell step failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${tail}`;

    return {
      artifactId: artifact?.id,
      exitCode: result.exitCode,
      filesChanged: finalize.filesChanged,
      passed,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(finalize.committedSha ? { committedSha: finalize.committedSha } : {}),
      // Defense in depth: every summary built from `tail`/`passSummary` below
      // this point is redacted again here, not just the pushError branch
      // above — so a future code path that forgets to thread the token
      // through still can't leak it. (The `ShellImageNotAllowedError` early
      // return above this point is a separate return statement and skips
      // this redaction entirely — safe today because that path never touches
      // repo/git output, only `assertShellImageAllowed`'s own message.)
      summary: redactToken(summary, meta.token),
    };
  } finally {
    await safeRunDocker(['volume', 'rm', '-f', volumeName]);
  }
}
