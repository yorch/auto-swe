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
 *
 * Return shape mirrors the phase-2 GateResult so the interpreter's
 * gate-failure path (`passed === false` → onFail policy) fires uniformly for
 * both quality gates and shell steps.
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { assertShellImageAllowed, ShellImageNotAllowedError } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { currentWorkflowId, currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { requireEnv } from '../lib/errors.js';
import { EXEC_OPTS } from '../lib/execUtils.js';
import { recordLessonBackground } from './commitToMemory.js';
import { truncate } from './qualityGates.js';
import { shellQuote } from './workspace.js';

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

// Tiny (~5MB) helper image with git built-in, used by the prep + finalize phases.
const GIT_HELPER_IMAGE = 'alpine/git:latest';

/**
 * Redact the GitHub token from any string. `runDocker` invokes `git clone`
 * with the token embedded in the URL (see `loadRepoMeta`), and `execSync`
 * throws with the full command in `error.message` + may also carry it in
 * `error.stdout` / `error.stderr`. Without this, a failed clone would leak
 * the token into the Temporal workflow history.
 */
function redactToken(s: unknown): string {
  if (typeof s !== 'string') return String(s);
  const token = process.env.GITHUB_TOKEN;
  if (!token) return s;
  return s.split(token).join('***');
}

function runDocker(args: string[]): string {
  // execSync prefers a string command, so we shell-quote each arg before
  // joining. The inputs to this helper are either hard-coded literals or
  // identifiers that have already been validated upstream (volume names,
  // images checked against DOCKER_IMAGE_REF_RE, branch names quoted by the
  // caller) — never raw user input from a spec.
  const quoted = args.map(shellQuote).join(' ');
  try {
    return execSync(`docker ${quoted}`, EXEC_OPTS) as string;
  } catch (err) {
    if (err instanceof Error) err.message = redactToken(err.message);
    const e = err as { stdout?: unknown; stderr?: unknown };
    if (typeof e.stdout === 'string') e.stdout = redactToken(e.stdout);
    if (typeof e.stderr === 'string') e.stderr = redactToken(e.stderr);
    throw err;
  }
}

function safeRunDocker(args: string[]): void {
  try {
    runDocker(args);
  } catch {
    /* best-effort */
  }
}

interface RepoMeta {
  cloneUrl: string;
  defaultBranch: string;
  teamId: string;
  teamAllowlist: string[];
}

async function loadRepoMeta(request: RepoWorkRequest): Promise<RepoMeta> {
  const repo = await prisma.repository.findUniqueOrThrow({
    include: { team: { select: { id: true, shellImageAllowlist: true } } },
    where: { id: request.repoId },
  });
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const token = requireEnv('GITHUB_TOKEN');
  const cloneUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`.replace(
    'https://',
    `https://x-access-token:${token}@`
  );
  return {
    cloneUrl,
    defaultBranch: repo.defaultBranch,
    teamAllowlist: (repo.team?.shellImageAllowlist as string[] | null) ?? [],
    teamId: repo.team?.id ?? '',
  };
}

/**
 * Clone the branch into the given volume. Falls back to the default branch
 * *only* when git reports the branch doesn't exist remotely (e.g. shell step
 * runs before the implementer's first push). Auth / network / docker
 * failures are surfaced unchanged so they're not masked by a confusing
 * default-branch retry. Caller owns volume lifecycle.
 */
function cloneIntoVolume(volumeName: string, meta: RepoMeta, branch: string): void {
  const tryClone = (refspec: string): string =>
    runDocker([
      'run',
      '--rm',
      '-v',
      `${volumeName}:/workspace:rw`,
      '--entrypoint',
      'sh',
      GIT_HELPER_IMAGE,
      '-c',
      `git clone --depth=50 -b ${shellQuote(refspec)} ${shellQuote(meta.cloneUrl)} /workspace/repo && cd /workspace/repo && git config user.name 'auto-swe' && git config user.email 'auto-swe@localhost'`,
    ]);
  try {
    tryClone(branch);
  } catch (err) {
    if (!isBranchNotFoundError(err)) throw err;
    tryClone(meta.defaultBranch);
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
 */
function finalizeWorkspaceVolume(
  volumeName: string,
  branch: string,
  commandSummary: string
): FinalizeResult {
  const script = [
    'set -e',
    'cd /workspace/repo',
    'if [ -z "$(git status --porcelain)" ]; then',
    '  echo NO_CHANGES',
    '  exit 0',
    'fi',
    'git add -A',
    `git commit -m ${shellQuote(`auto: shell step ${commandSummary}`)}`,
    `git push origin HEAD:${shellQuote(branch)}`,
    'git rev-parse HEAD',
    'git diff --name-only HEAD~1 HEAD',
  ].join('\n');
  const out = runDocker([
    'run',
    '--rm',
    '-v',
    `${volumeName}:/workspace:rw`,
    '--entrypoint',
    'sh',
    GIT_HELPER_IMAGE,
    '-c',
    script,
  ]);
  if (out.includes('NO_CHANGES')) return { filesChanged: [] };
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

  const branchPrefix = process.env.BRANCH_PREFIX ?? 'auto';
  const branch = input.branch ?? `${branchPrefix}/${input.request.externalTicketId}`;

  const volumeName = `shellvol-${crypto.randomBytes(8).toString('hex')}`;
  runDocker(['volume', 'create', volumeName]);
  try {
    heartbeat('shell-step: cloning branch into workspace volume');
    cloneIntoVolume(volumeName, meta, branch);

    heartbeat('shell-step: running command');
    const result = runEphemeralContainer({
      command: input.command,
      cpus: input.cpus,
      image: input.image,
      memory: input.memory,
      network: input.network ?? 'none',
      timeoutMs: input.timeoutMs,
      workdir: '/workspace/repo',
      workspaceMount: volumeName,
    });

    const fullLog = `$ ${input.command}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
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
        finalize = finalizeWorkspaceVolume(volumeName, branch, input.command.slice(0, 80));
      } catch (err) {
        // A push failure shouldn't mask a successful command run, but the
        // caller needs to know changes weren't persisted. Surface the
        // (token-redacted) error in the summary alongside passed=true.
        const e = err as { stderr?: unknown; message?: unknown };
        const raw =
          (typeof e.stderr === 'string' && e.stderr) ||
          (typeof e.message === 'string' && e.message) ||
          String(err);
        pushError = redactToken(raw).slice(0, 500);
      }
    }

    const tail = truncate(`${result.stderr || result.stdout}`.trim(), 4000);
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
        repoId: input.request.repoId,
        temporalWorkflowId: currentWorkflowId(),
      });
    }

    return {
      artifactId: artifact?.id,
      exitCode: result.exitCode,
      filesChanged: finalize.filesChanged,
      passed,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(finalize.committedSha ? { committedSha: finalize.committedSha } : {}),
      summary: passed
        ? passSummary
        : `shell step failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${tail}`,
    };
  } finally {
    safeRunDocker(['volume', 'rm', '-f', volumeName]);
  }
}
