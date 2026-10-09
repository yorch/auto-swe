/**
 * Verifying a CI fix before it is delivered (docs/ci-failure-triggers.md): the command the
 * triager says reproduces the failure is run in a fresh workspace on the failing branch, then
 * on the fix. Failing before and passing after verifies the fix.
 *
 * The command is model output read from untrusted logs, so it runs only when it appears
 * verbatim in the failing workflow file in the repository — the repository's own command, as
 * trusted as the code its tests run — and the shell scanner clears it. The workspace installs
 * nothing first, so a command that needs the workflow's setup steps fails both times; that is
 * reported, never treated as proof the fix is wrong. Verification only labels a fix; it never
 * stops one from being delivered.
 */
import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { getErrorMessage } from '../lib/errors.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { scanShellCommand } from '../lib/shellCommandScanner.js';
import type { CiTriageResult } from './ciTriage.js';
import { createWorkspace, fetchBranchesSubcommand, shellQuote } from './workspace.js';

/** The longest reproduction command kept; a longer one is dropped, never cut. */
export const MAX_REPRO_COMMAND_CHARS = 1_000;
/** Wall-clock for each of the two runs of the command. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** A workflow file path as GitHub reports it; anything else is not read. */
const WORKFLOW_PATH_RE = /^\.github\/workflows\/[\w./-]{1,200}\.ya?ml$/;

export type CiVerificationStatus =
  /** Failed on the failing branch and passed on the fix. */
  | 'verified'
  /** Passed on the failing branch: the failure could not be reproduced here. */
  | 'not_reproduced'
  /** Failed on both: the fix did not make it pass, or the command needs setup it lacks. */
  | 'still_failing'
  /** Not run: no usable command, or the workspace could not run it. */
  | 'unverified';

export interface CiVerification {
  status: CiVerificationStatus;
  /** One sentence, for the pull request and the run's result. */
  summary: string;
  /** The command run, when one was. */
  command: string | null;
  beforeExitCode: number | null;
  afterExitCode: number | null;
  /** Both runs' output, when the command ran. */
  artifactId?: string;
}

export interface VerifyCiFixResult {
  verification: CiVerification;
  /** The code result with the verification in its notes, for the pull request's body. */
  codeResult: CodeResult;
}

/** Each line trimmed, blank lines dropped: a `run:` block's indentation is not the command. */
function normalise(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Why the command may not run, or null when it may. Pure: the workflow file's text is read by
 * the caller. The scanner is applied separately.
 */
export function reproCommandProblem(command: string, workflowFile: string): string | null {
  const c = normalise(command);
  if (c.length === 0) {
    return 'the triager named no command that reproduces the failure';
  }
  if (command.length > MAX_REPRO_COMMAND_CHARS) {
    return 'the reproduction command is too long';
  }
  if (c.includes('${{')) {
    return 'the reproduction command uses workflow expressions, which only GitHub can resolve';
  }
  if (!normalise(workflowFile).includes(c)) {
    return 'the reproduction command is not in the failing workflow file';
  }
  return null;
}

function unverified(summary: string, command: string | null = null): CiVerification {
  return { afterExitCode: null, beforeExitCode: null, command, status: 'unverified', summary };
}

/** The verification as one line of the pull request's body. */
export function verificationNote(v: CiVerification): string {
  const label: Record<CiVerificationStatus, string> = {
    not_reproduced: 'Unverified',
    still_failing: 'Unverified',
    unverified: 'Unverified',
    verified: 'Verified',
  };
  return `**${label[v.status]}:** ${v.summary}`;
}

function withNote(codeResult: CodeResult, v: CiVerification): CodeResult {
  const note = verificationNote(v);
  return {
    ...codeResult,
    implementationNotes: codeResult.implementationNotes
      ? `${note}\n\n${codeResult.implementationNotes}`
      : note,
  };
}

export async function verifyCiFix(input: {
  request: RepoWorkRequest;
  triage: CiTriageResult;
  codeResult: CodeResult;
}): Promise<VerifyCiFixResult> {
  const verification = await verify(input);
  return { codeResult: withNote(input.codeResult, verification), verification };
}

async function verify(input: {
  request: RepoWorkRequest;
  triage: CiTriageResult;
  codeResult: CodeResult;
}): Promise<CiVerification> {
  const { request, triage, codeResult } = input;
  const command = (triage.reproCommand ?? '').trim();
  const path = triage.run?.path ?? '';
  if (command.length === 0) {
    return unverified('the triager named no command that reproduces the failure');
  }
  if (!WORKFLOW_PATH_RE.test(path)) {
    return unverified('the failing workflow file could not be read');
  }
  const blocked = await scanShellCommand(command);
  if (blocked) {
    return unverified('the shell command scanner refused the reproduction command', command);
  }

  const [repo, workflowDefaults] = await Promise.all([
    prisma.connection.findUniqueOrThrow({
      include: { installation: { select: { host: true, installationId: true } } },
      where: { id: requireRepoId(request, 'verifyCiFix') },
    }),
    resolveWorkflowDefaults(),
  ]);
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);
  const baseBranch = await resolveRequestBaseBranch(request, repo);
  const fixBranch =
    codeResult.branch || `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;

  heartbeat('verifyCiFix: preparing the workspace');
  // Cloned at the failing branch: the "before" run sees the code that failed.
  const workspace = await createWorkspace(
    authedCloneUrl,
    fixBranch,
    baseBranch,
    repo.executorImage ?? undefined
  );
  try {
    const file = await workspace.execCapture(`cat -- ${shellQuote(path)}`);
    if (file.exitCode !== 0) {
      return unverified('the failing workflow file is not on the branch', command);
    }
    const problem = reproCommandProblem(command, file.stdout);
    if (problem) {
      return unverified(problem, command);
    }

    heartbeat('verifyCiFix: running the command on the failing branch');
    const before = await workspace.execCapture(command, { timeoutMs: RUN_TIMEOUT_MS });
    try {
      await workspace.gitAuthed(fetchBranchesSubcommand([fixBranch]));
      await workspace.exec(`git reset --hard origin/${shellQuote(fixBranch)}`);
    } catch (err) {
      return unverified(
        `the fix branch could not be checked out (${getErrorMessage(err).slice(0, 200)})`,
        command
      );
    }
    heartbeat('verifyCiFix: running the command on the fix');
    const after = await workspace.execCapture(command, { timeoutMs: RUN_TIMEOUT_MS });

    const runId = await currentWorkflowRunId();
    const artifact = await putArtifact({
      body:
        `$ ${command}\n\n=== before the fix (${baseBranch}): exit ${before.exitCode} ===\n` +
        `${before.stdout}\n${before.stderr}\n\n=== after the fix (${fixBranch}): exit ${after.exitCode} ===\n` +
        `${after.stdout}\n${after.stderr}`,
      contentType: 'text/plain; charset=utf-8',
      kind: 'ci.verify',
      runId,
    }).catch(() => null);

    const failedBefore = before.exitCode !== 0 || Boolean(before.signal);
    const passedAfter = after.exitCode === 0 && !after.signal;
    // The repository's own text, but shown in Markdown: no backticks to break out of the span.
    const shown = (command.split('\n')[0] ?? '').slice(0, 120).replace(/`/g, "'");
    const base = {
      afterExitCode: after.exitCode,
      beforeExitCode: before.exitCode,
      command,
      ...(artifact ? { artifactId: artifact.id } : {}),
    };
    if (!failedBefore) {
      return {
        ...base,
        status: 'not_reproduced',
        summary: `\`${shown}\` passed before the fix too, so the failure could not be reproduced outside CI`,
      };
    }
    if (passedAfter) {
      return {
        ...base,
        status: 'verified',
        summary: `\`${shown}\` failed before the fix (exit ${before.exitCode}) and passes with it`,
      };
    }
    return {
      ...base,
      status: 'still_failing',
      summary:
        `\`${shown}\` fails before and after the fix (exit ${after.exitCode}); the fix may be ` +
        'incomplete, or the command may need setup that only the workflow provides',
    };
  } finally {
    await workspace.destroy();
  }
}
