/**
 * Phase-3 activities for feature-level decomposition + branch merging.
 *
 *   planDecomposition  — calls the decomposer agent and returns Subtask[]
 *   mergeBranches      — merges N subtask branches into the parent feature
 *                        branch in a fresh workspace; aborts on conflict and
 *                        pushes only when every source merged cleanly
 */

import { prisma } from '@auto-swe/shared/db';
import type {
  DecompositionResult,
  RepoWorkRequest,
  Subtask,
} from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { planDecomposition as decomposerPlan } from '../agents/decomposer.js';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { getExecErrorOutput, requireEnv } from '../lib/errors.js';
import { createWorkspace, shellQuote } from './workspace.js';

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
  /**
   * Reference to a `WorkflowArtifact` whose body is the line-oriented merge log
   * (one entry per fetch / reset / merge / abort / push, plus the truncated
   * conflict output for the failing branch). Unset if artifact storage failed.
   */
  artifactId?: string;
  /** HEAD SHA of the target branch after a successful push. Unset on failure. */
  headSha?: string;
}

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

    // Batched fetch — one round-trip for the target + every source. If the
    // single fetch fails (e.g. one ref missing) fall back to per-ref so we
    // still pick up whatever exists.
    const refs = [targetBranch, ...sourceBranches];
    const refList = refs.map((r) => shellQuote(r)).join(' ');
    try {
      workspace.exec(`git fetch origin ${refList}`);
      log.push(`fetched ${refs.join(', ')}`);
    } catch {
      log.push('batched fetch failed; retrying per-ref');
      for (const r of refs) {
        try {
          workspace.exec(`git fetch origin ${shellQuote(r)}`);
          log.push(`fetched ${r}`);
        } catch {
          log.push(`fetch ${r} failed (branch may not exist remotely)`);
        }
      }
    }

    try {
      workspace.exec(`git reset --hard origin/${shellQuote(targetBranch)}`);
      log.push(`reset to origin/${targetBranch}`);
    } catch {
      log.push(`origin/${targetBranch} not found; starting from defaultBranch`);
    }

    for (const source of sourceBranches) {
      heartbeat(`mergeBranches: merging ${source}`);
      const messagePrefix = input.mergeMessagePrefix ?? 'auto-merge';
      const message = `${messagePrefix}: merge ${source} into ${targetBranch}`;
      try {
        workspace.exec(
          `git merge --no-ff --no-edit -m ${shellQuote(message)} origin/${shellQuote(source)}`
        );
        merged.push(source);
        log.push(`merged ${source}`);
      } catch (err: unknown) {
        const output = getExecErrorOutput(err, 4000);
        // Abort so MERGE_HEAD doesn't linger if a later code path tries to push.
        try {
          workspace.exec('git merge --abort');
        } catch {
          /* already clean */
        }
        conflicts.push({ branch: source, output });
        log.push(`CONFLICT merging ${source}:\n${output.slice(-2000)}`);
        break;
      }
    }

    let headSha: string | undefined;
    if (merged.length > 0 && conflicts.length === 0) {
      workspace.exec(`git push origin ${shellQuote(targetBranch)}`);
      headSha = workspace.exec('git rev-parse HEAD').trim();
      log.push(`pushed ${targetBranch} (head ${headSha})`);
    }

    const artifact = await putArtifact({
      body: log.join('\n'),
      contentType: 'text/plain; charset=utf-8',
      kind: 'merge.log',
      runId: await currentWorkflowRunId(),
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

/**
 * Derive the standard subtask branch name from a parent feature branch +
 * subtask id: `auto/JIRA-1234` + `auth` → `auto/JIRA-1234/auth`.
 */
export function subtaskBranchName(featureBranch: string, subtask: Pick<Subtask, 'id'>): string {
  return `${featureBranch}/${subtask.id}`;
}
