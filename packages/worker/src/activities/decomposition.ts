/**
 * Phase-3 activities for feature-level decomposition + branch merging.
 *
 *   planDecomposition  — calls the decomposer agent and returns Subtask[]
 *   mergeBranches      — fast-forwards / merges N subtask branches into the
 *                        parent feature branch in a fresh workspace
 *
 * Both stay thin: heavy lifting lives in agents/ and workspace.ts. The
 * activities only handle prisma lookups, workspace lifecycle, and shaping
 * outputs into the `{passed, summary, artifactId?}` envelope the interpreter
 * understands.
 */

import { prisma } from '@auto-swe/shared/db';
import type {
  DecompositionResult,
  RepoWorkRequest,
  Subtask,
} from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { planDecomposition as decomposerPlan } from '../agents/decomposer.js';
import { currentWorkflowId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { requireEnv } from '../lib/errors.js';
import { createWorkspace, shellQuote, type Workspace } from './workspace.js';

export async function planDecomposition(request: RepoWorkRequest): Promise<DecompositionResult> {
  heartbeat('plan decomposition: calling agent');
  return decomposerPlan(request);
}

export interface MergeBranchesInput {
  request: RepoWorkRequest;
  /** The branch that all source branches should be merged into. */
  targetBranch: string;
  /** Branches to merge, in order. Each must already exist on the remote. */
  sourceBranches: string[];
  /** Commit message prefix for each merge commit. */
  mergeMessagePrefix?: string;
}

export interface MergeBranchesResult {
  /** True iff every source branch merged cleanly into the target. */
  passed: boolean;
  summary: string;
  /** Branches that merged successfully (in order). */
  mergedBranches: string[];
  /** Per-branch conflict report, populated when `passed === false`. */
  conflicts: Array<{ branch: string; output: string }>;
  /** Full git log + diff lives here; the inline summary is truncated. */
  artifactId?: string;
  /** HEAD SHA of the target branch after all successful merges (or before, on early fail). */
  headSha?: string;
}

/**
 * Merge N source branches into a target branch in a fresh workspace.
 *
 * Strategy:
 *   1. Provision a workspace cloned from the repo's defaultBranch.
 *   2. Fetch every source branch and the target branch.
 *   3. Check out / create the target branch starting from defaultBranch.
 *   4. Fast-forward through source branches in order. If any branch produces
 *      a merge conflict, abort that merge and stop. Earlier successful merges
 *      remain on the branch and are pushed; later branches are reported as
 *      unattempted (not in `mergedBranches`, not in `conflicts`).
 *   5. Push the target branch.
 *
 * Conflict-resolution agent is reserved for phase 3.5 — see
 * docs/configurable-workflows.md.
 */
export async function mergeBranches(input: MergeBranchesInput): Promise<MergeBranchesResult> {
  const { request, targetBranch, sourceBranches } = input;
  if (sourceBranches.length === 0) {
    return {
      conflicts: [],
      mergedBranches: [],
      passed: true,
      summary: `mergeBranches: no source branches; target ${targetBranch} unchanged`,
    };
  }

  const repo = await prisma.repository.findUniqueOrThrow({ where: { id: request.repoId } });
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const githubToken = requireEnv('GITHUB_TOKEN');

  const workspace = createWorkspace(
    repoUrl,
    targetBranch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  const log: string[] = [];
  const merged: string[] = [];
  const conflicts: Array<{ branch: string; output: string }> = [];

  try {
    heartbeat('mergeBranches: workspace provisioned');

    // Pull in remote refs for every branch we care about. If the target
    // branch already exists remotely we want to start from that head; if it
    // doesn't, the local clone's branch (forked from defaultBranch) is fine.
    safeFetch(workspace, targetBranch, log);
    try {
      workspace.exec(`git reset --hard origin/${shellQuote(targetBranch)}`);
      log.push(`reset to origin/${targetBranch}`);
    } catch {
      log.push(`origin/${targetBranch} not found; starting from defaultBranch`);
    }

    for (const source of sourceBranches) {
      heartbeat(`mergeBranches: merging ${source}`);
      safeFetch(workspace, source, log);
      const messagePrefix = input.mergeMessagePrefix ?? 'auto-merge';
      const message = `${messagePrefix}: merge ${source} into ${targetBranch}`;
      try {
        workspace.exec(
          `git merge --no-ff --no-edit -m ${shellQuote(message)} origin/${shellQuote(source)}`
        );
        merged.push(source);
        log.push(`merged ${source}`);
      } catch (err: unknown) {
        const stdout = extractStdout(err);
        // Abort the failed merge so the workspace returns to a clean state
        // for the next attempt (we don't attempt later sources anyway, but
        // the abort prevents lingering MERGE_HEAD state during push).
        try {
          workspace.exec('git merge --abort');
        } catch {
          // already-clean; ignore
        }
        conflicts.push({ branch: source, output: stdout.slice(-4000) });
        log.push(`CONFLICT merging ${source}:\n${stdout.slice(-2000)}`);
        break;
      }
    }

    let headSha: string | undefined;
    if (merged.length > 0 && conflicts.length === 0) {
      // Push only when everything merged cleanly — partial pushes would
      // leave the remote in an unexpected state for downstream gates.
      workspace.exec(`git push origin ${shellQuote(targetBranch)}`);
      headSha = workspace.exec('git rev-parse HEAD').trim();
      log.push(`pushed ${targetBranch} (head ${headSha})`);
    } else if (merged.length === 0 && conflicts.length === 0) {
      headSha = workspace.exec('git rev-parse HEAD').trim();
    }

    const artifact = await putArtifact({
      body: log.join('\n'),
      contentType: 'text/plain; charset=utf-8',
      kind: 'merge.log',
      runId: await currentRunIdForWorkflow(),
    }).catch(() => null);

    const passed = conflicts.length === 0;
    const summary = passed
      ? `merged ${merged.length}/${sourceBranches.length} branches into ${targetBranch}`
      : `merge failed at ${conflicts[0]?.branch}: ${conflicts[0]?.output.slice(0, 400)}`;

    return {
      ...(artifact ? { artifactId: artifact.id } : {}),
      ...(headSha ? { headSha } : {}),
      conflicts,
      mergedBranches: merged,
      passed,
      summary,
    };
  } finally {
    workspace.destroy();
  }
}

function safeFetch(ws: Workspace, ref: string, log: string[]): void {
  try {
    ws.exec(`git fetch origin ${shellQuote(ref)}`);
    log.push(`fetched ${ref}`);
  } catch {
    log.push(`fetch ${ref} failed (branch may not exist remotely)`);
  }
}

function extractStdout(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof e.stdout === 'string') parts.push(e.stdout);
  if (typeof e.stderr === 'string') parts.push(e.stderr);
  if (parts.length === 0 && typeof e.message === 'string') parts.push(e.message);
  return parts.join('\n');
}

async function currentRunIdForWorkflow(): Promise<string | undefined> {
  try {
    const wid = currentWorkflowId();
    if (!wid) return undefined;
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId: wid },
    });
    return run?.id;
  } catch {
    return undefined;
  }
}

/**
 * Helper for tests + the runnable dispatcher: derive the standard subtask
 * branch name from a parent feature branch + subtask id.
 *
 *   featureBranch = "auto/JIRA-1234"
 *   subtask.id    = "auth-models"
 *   →              "auto/JIRA-1234/auth-models"
 */
export function subtaskBranchName(featureBranch: string, subtask: Pick<Subtask, 'id'>): string {
  return `${featureBranch}/${subtask.id}`;
}
