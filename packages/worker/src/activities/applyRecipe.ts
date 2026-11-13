/**
 * The `applyRecipe` step: run one code-owned campaign recipe against the run's repository.
 *
 * A recipe (`@auto-swe/shared/lib/campaignRecipes`) is a deterministic script, not an agent. This
 * step runs it through the `shell` step machinery (`runShellStep`: an allowlisted image, a volume
 * with no credential in it, the run's egress policy, commit-and-push only on exit 0) and reports
 * one of four things the template routes on:
 *
 *  - `skipped`: the campaign has no recipe, so nothing ran;
 *  - `passed` with no files changed: the repository is not affected (it does not use the package,
 *    or it is already at the version);
 *  - `passed` with files changed: the change is on the work branch, described as a `CodeResult`
 *    so the verification gate, the gate-fix session and the pull-request step can use it;
 *  - not `passed`: the recipe could not apply. Nothing was pushed, so an agent that takes over
 *    starts cleanly from the base.
 *
 * It never throws for a recipe that fails or a toolchain that cannot run, because the agent
 * fallback is the answer to that; it throws only for a cancellation. The parameters are validated
 * again here: the payload text is not trusted on the worker.
 */
import { parseRecipeParams } from '@auto-swe/shared/lib/campaignRecipes';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { generatedPathspecs } from '@auto-swe/shared/lib/testIntegrity';
import { workBranchOf } from '@auto-swe/shared/lib/workflowId';
import type { CodeResult, FileChange, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { CancelledFailure } from '@temporalio/activity';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { buildRecipeCommand, recipeRuntime } from '../lib/campaignRecipes.js';
import { maskCredentialShapes } from '../lib/redactToken.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { execPinned } from './allowedPaths.js';
import { pinnedGit } from './protectedTests.js';
import { provisionGateWorkspace } from './qualityGates.js';
import { runShellStep } from './shellStep.js';
import { fetchBranchesSubcommand, shellQuote, type Workspace } from './workspace.js';

export interface ApplyRecipeInput {
  request: RepoWorkRequest;
  /** A catalogue ref such as `npm-dependency@1`; absent for an agent-only campaign. */
  recipe?: string;
  /** The recipe's parameters, as the run payload carried them (validated here). */
  params?: unknown;
}

export interface ApplyRecipeResult {
  /** No recipe was named, so nothing ran. */
  skipped: boolean;
  /** The recipe ran and ended as asked (a change, or nothing to change). */
  passed: boolean;
  exitCode?: number;
  summary: string;
  artifactId?: string;
  /** Paths the recipe changed on the work branch; empty when the repository is not affected. */
  filesChanged: string[];
  /** The change, ready for the gates and the pull request. Present when files changed. */
  codeResult?: CodeResult;
}

/** The activity event the recipe records. */
export const RECIPE_EVENT = 'campaign.recipe';

/** Longest diff kept on the code result. */
const MAX_DIFF_CHARS = 200_000;

/** Longest error text carried in a summary. */
const MAX_ERROR_CHARS = 300;

function fileChangesFrom(
  nameStatus: string,
  numstat: string
): Pick<FileChange, 'path' | 'operation' | 'linesAdded' | 'linesRemoved' | 'language'>[] {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split('\n')) {
    const [added, removed, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (path !== '' && added !== undefined && removed !== undefined) {
      counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
    }
  }
  const parts = nameStatus.split('\0');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  const out: ReturnType<typeof fileChangesFrom> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const path = parts[i + 1] as string;
    out.push({
      language: path.split('.').pop() ?? '',
      linesAdded: counts.get(path)?.added ?? 0,
      linesRemoved: counts.get(path)?.removed ?? 0,
      operation: status === 'A' ? 'CREATE' : status === 'D' ? 'DELETE' : 'MODIFY',
      path,
    });
  }
  return out;
}

/**
 * Describe the recipe's pushed commit as a `CodeResult`: check the work branch out in a gate-style
 * workspace (no setup run, since nothing is built here) and read the change. The tests have not
 * been run, and the result says so.
 *
 * Both ends are the platform's own commits, never refs resolved here: the head is the sha the
 * shell step's finalize committed and pushed (a branch tip that is any other commit is refused),
 * and the base is that commit's first parent, the commit the shell step cut the branch from. The
 * recipe step is the first to touch the branch, and only the platform wrote that commit (with the
 * volume's git config rewritten first), so its parent is not something a recipe or an agent chose.
 * That base is what the protected verification later restores the tests to.
 */
async function describeChange(
  request: RepoWorkRequest,
  branch: string,
  committedSha: string | undefined,
  note: string
): Promise<CodeResult> {
  const { workspace, baseBranch } = await provisionGateWorkspace(request, 'runTests', branch, {
    skipSetup: true,
  });
  try {
    return await readCodeResult(workspace, request, { baseBranch, branch, committedSha, note });
  } finally {
    await workspace.destroy();
  }
}

const SHA = /^[0-9a-f]{40,64}$/;

async function readCodeResult(
  workspace: Pick<Workspace, 'exec' | 'gitAuthed'>,
  request: RepoWorkRequest,
  ctx: { baseBranch: string; branch: string; committedSha: string | undefined; note: string }
): Promise<CodeResult> {
  const headSha = (
    await workspace.exec(pinnedGit(`rev-parse --verify ${shellQuote('HEAD^{commit}')}`))
  ).trim();
  if (!SHA.test(headSha) || headSha !== ctx.committedSha) {
    throw new Error(`the tip of ${ctx.branch} is not the commit the recipe pushed`);
  }
  // The first parent, read by sha; a shallow history is deepened until it reaches it.
  const readParent = async (): Promise<string> => {
    try {
      const sha = (
        await workspace.exec(pinnedGit(`rev-parse --verify ${shellQuote(`${headSha}^1`)}`))
      ).trim();
      return SHA.test(sha) ? sha : '';
    } catch {
      return '';
    }
  };
  let base = await readParent();
  for (const depth of [1, 200]) {
    if (base) {
      break;
    }
    try {
      await workspace.gitAuthed(
        fetchBranchesSubcommand([ctx.baseBranch, ctx.branch]).replace(
          /^fetch /,
          `fetch --deepen=${depth} --no-tags `
        )
      );
    } catch {
      break;
    }
    base = await readParent();
  }
  if (!base) {
    throw new Error(`could not read the commit ${ctx.branch} was cut from`);
  }
  const range = `${base} ${headSha}`;
  const common = '-r --no-renames --ignore-submodules=none';
  // Each read ends in a per-call marker, so a capture cut short fails instead of describing less.
  const [nameStatus, numstat, patch] = await Promise.all([
    execPinned(workspace, pinnedGit(`diff-tree ${common} -z --name-status ${range}`)),
    execPinned(workspace, pinnedGit(`diff-tree ${common} --numstat ${range}`)),
    // Generated files (lockfiles) are left out of the patch: they can be megabytes, and the
    // result crosses a workflow boundary. They stay in the file list.
    execPinned(
      workspace,
      pinnedGit(
        `diff-tree ${common} -p --text --no-ext-diff --no-textconv --no-color -U3 ${range} -- ` +
          [':(top)', ...generatedPathspecs()].map((p) => shellQuote(p)).join(' '),
        { literalPathspecs: false }
      )
    ),
  ]);
  const diff = patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n…` : patch;
  return {
    baseBranch: ctx.baseBranch,
    baseSha: base,
    branch: ctx.branch,
    diff,
    filesChanged: fileChangesFrom(nameStatus, numstat),
    headSha,
    implementationNotes: ctx.note,
    repoId: requireRepoId(request, 'applyRecipe'),
    testResults: {
      // Not run here: the protected test gate runs the repository's original tests afterwards.
      // `passed: false` with nothing failing reads as "not run" in the pull-request text.
      duration_ms: 0,
      failing: 0,
      passed: false,
      passing: 0,
      stdout: 'not run by the recipe step; verified by the protected test gate',
      total: 0,
    },
  };
}

export async function applyRecipe(input: ApplyRecipeInput): Promise<ApplyRecipeResult> {
  const tracer = new AgentTracer();
  const started = Date.now();
  try {
    if (input.recipe === undefined || input.recipe === '') {
      tracer.addActivityEvent({ name: RECIPE_EVENT, outputJson: { skipped: true } });
      return { filesChanged: [], passed: false, skipped: true, summary: 'no recipe named' };
    }
    const parsed = parseRecipeParams(input.recipe, input.params);
    if (!parsed.ok) {
      tracer.addActivityEvent({
        error: parsed.error,
        name: RECIPE_EVENT,
        outputJson: { invalidParameters: true },
      });
      return { filesChanged: [], passed: false, skipped: false, summary: parsed.error };
    }
    const { image, timeoutMs } = recipeRuntime(parsed.ref);
    const { branchPrefix } = await resolveWorkflowDefaults();
    const branch = workBranchOf(input.request, branchPrefix);
    const note = `Applied recipe ${parsed.ref}: ${parsed.params.packageName} to ${parsed.params.targetVersion}. The platform runs the repository's original tests on this change before a pull request is opened.`;

    let shell: Awaited<ReturnType<typeof runShellStep>>;
    try {
      shell = await runShellStep({
        branch,
        command: buildRecipeCommand(parsed.ref, parsed.params),
        image,
        network: 'egress',
        request: input.request,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof CancelledFailure) {
        throw err;
      }
      const message = maskCredentialShapes(err instanceof Error ? err.message : String(err)).slice(
        0,
        MAX_ERROR_CHARS
      );
      tracer.addActivityEvent({
        error: message,
        name: RECIPE_EVENT,
        outputJson: { ran: false, ref: parsed.ref },
      });
      return {
        filesChanged: [],
        passed: false,
        skipped: false,
        summary: `recipe ${parsed.ref} could not run: ${message}`,
      };
    }

    let codeResult: CodeResult | undefined;
    if (shell.passed && shell.filesChanged.length > 0) {
      codeResult = await describeChange(input.request, branch, shell.committedSha, note);
    }
    tracer.addActivityEvent({
      durationMs: Date.now() - started,
      name: RECIPE_EVENT,
      outputJson: {
        exitCode: shell.exitCode,
        filesChanged: shell.filesChanged.length,
        passed: shell.passed,
        persisted: shell.persisted,
        ref: parsed.ref,
      },
    });
    return {
      ...(shell.artifactId ? { artifactId: shell.artifactId } : {}),
      ...(codeResult ? { codeResult } : {}),
      exitCode: shell.exitCode,
      filesChanged: shell.filesChanged,
      passed: shell.passed,
      skipped: false,
      summary: shell.summary,
    };
  } finally {
    await persistActivityTrace(tracer, 'applyRecipe').catch(() => false);
  }
}
