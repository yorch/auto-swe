/**
 * Phase-3 / 3.5 activities for feature-level decomposition + branch merging.
 *
 *   planDecomposition    — calls the decomposer agent and returns Subtask[]
 *   mergeBranches        — merges N subtask branches into the parent feature
 *                          branch in a fresh workspace; aborts on conflict and
 *                          pushes only when every source merged cleanly. Exposes
 *                          the unmerged tail so a downstream resolver can pick up.
 *   resolveMergeConflict — replays the unmerged tail through the implementer
 *                          agent (one Mastra call per conflicted branch) to
 *                          rewrite conflict markers, then commits + pushes.
 */

import { prisma } from '@auto-swe/shared/db';
import type {
  DecompositionResult,
  RepoWorkRequest,
  Subtask,
} from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { planDecomposition as decomposerPlan } from '../agents/decomposer.js';
import { createImplementerAgent } from '../agents/implementer.js';
import { MERGE_CONFLICT_RESOLVER_PROMPT } from '../agents/prompts.js';
import { currentWorkflowId, currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorOutput, requireEnv } from '../lib/errors.js';
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
  /**
   * Branches that did NOT merge cleanly — the conflicted branch plus every
   * source queued after it. Empty when `passed === true`. Designed to bind
   * directly into `resolveMergeConflict.inputs.sourceBranches`.
   */
  unmergedBranches: string[];
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
      unmergedBranches: [],
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

    const unmerged: string[] = [];
    for (let idx = 0; idx < sourceBranches.length; idx++) {
      const source = sourceBranches[idx] as string;
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
        // Conflicted branch + every queued source becomes the unmerged tail
        // so a downstream `resolveMergeConflict` step can bind directly.
        unmerged.push(...sourceBranches.slice(idx));
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
      unmergedBranches: unmerged,
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

export interface ResolveMergeConflictInput {
  request: RepoWorkRequest;
  /** Target branch that all sources should be merged into (e.g. the feature branch). */
  targetBranch: string;
  /**
   * Branches that still need to be merged into `targetBranch`, in order. Pass
   * the unmerged tail from a prior `mergeBranches` failure (sources after the
   * one that conflicted, plus the conflicted one itself).
   */
  sourceBranches: string[];
  /** Commit message prefix; default 'auto-merge'. */
  mergeMessagePrefix?: string;
  /** Max attempts per branch (resolve + retry). Default 1. */
  maxAttemptsPerBranch?: number;
}

/**
 * Resolve merge conflicts in-place using the implementer agent.
 *
 * For each source branch:
 *   1. Attempt `git merge --no-commit --no-ff origin/<source>`.
 *   2. If the merge has conflicts (`git ls-files -u` non-empty), pass the
 *      conflict markers + branch context to the merge-conflict-resolver agent.
 *      The agent reads + rewrites the conflicted files via its standard tools.
 *   3. Verify no markers remain via a final `git diff --check`.
 *   4. Stage + commit the resolution; if any files are still in conflict the
 *      branch is recorded as a conflict and the run stops.
 *
 * If every branch is resolved cleanly, the target branch is pushed and a
 * `MergeBranchesResult`-shaped object is returned so spec authors can wire
 * this step in place of (or after) `mergeBranches` without changing the
 * downstream bindings.
 */
export async function resolveMergeConflict(
  input: ResolveMergeConflictInput
): Promise<MergeBranchesResult> {
  const { request, targetBranch, sourceBranches } = input;
  if (sourceBranches.length === 0) {
    return {
      conflicts: [],
      mergedBranches: [],
      passed: true,
      summary: `resolveMergeConflict: no source branches; target ${targetBranch} unchanged`,
      unmergedBranches: [],
    };
  }

  const maxAttemptsPerBranch = Math.max(1, input.maxAttemptsPerBranch ?? 1);
  const messagePrefix = input.mergeMessagePrefix ?? 'auto-merge';

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
    heartbeat('resolveMergeConflict: workspace provisioned');

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

    const unmerged: string[] = [];
    for (let idx = 0; idx < sourceBranches.length; idx++) {
      const source = sourceBranches[idx] as string;
      heartbeat(`resolveMergeConflict: merging ${source}`);
      const resolved = await mergeOneWithResolver(workspace, source, targetBranch, {
        log,
        maxAttempts: maxAttemptsPerBranch,
        messagePrefix,
        request,
      });
      if (resolved.passed) {
        merged.push(source);
      } else {
        conflicts.push({ branch: source, output: resolved.output });
        log.push(`UNRESOLVABLE CONFLICT merging ${source}:\n${resolved.output.slice(-2000)}`);
        unmerged.push(...sourceBranches.slice(idx));
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
      kind: 'merge.resolve.log',
      runId: await currentWorkflowRunId(),
    }).catch(() => null);

    const passed = conflicts.length === 0;
    const summary = passed
      ? `resolved + merged ${merged.length}/${sourceBranches.length} branches into ${targetBranch}`
      : `conflict resolution failed at ${conflicts[0]?.branch}: ${conflicts[0]?.output.slice(0, 400)}`;

    return {
      ...(artifact ? { artifactId: artifact.id } : {}),
      ...(headSha ? { headSha } : {}),
      conflicts,
      mergedBranches: merged,
      passed,
      summary,
      unmergedBranches: unmerged,
    };
  } finally {
    workspace.destroy();
  }
}

/**
 * Attempt one source merge with up to `maxAttempts` resolver passes if the
 * initial merge produces conflicts. Returns `{ passed, output }` where output
 * is either the merge stderr/stdout (on terminal failure) or empty (on pass).
 */
async function mergeOneWithResolver(
  workspace: Workspace,
  source: string,
  targetBranch: string,
  opts: {
    log: string[];
    maxAttempts: number;
    messagePrefix: string;
    request: RepoWorkRequest;
  }
): Promise<{ passed: boolean; output: string }> {
  const commitMessage = `${opts.messagePrefix}: merge ${source} into ${targetBranch}`;

  // First, try the clean merge.
  try {
    workspace.exec(
      `git merge --no-ff --no-edit -m ${shellQuote(commitMessage)} origin/${shellQuote(source)}`
    );
    opts.log.push(`merged ${source} cleanly`);
    return { output: '', passed: true };
  } catch (err) {
    const initialOutput = getExecErrorOutput(err, 4000);
    opts.log.push(`conflict on ${source}, invoking resolver`);
    // Continue to resolver attempts below.
    void initialOutput;
  }

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const conflictedFiles = listConflictedFiles(workspace);
    if (conflictedFiles.length === 0) {
      // No conflicts but the merge call still threw — likely a non-conflict
      // failure (e.g. dirty tree). Abort and surface.
      tryMergeAbort(workspace);
      return { output: 'merge failed without conflicted files', passed: false };
    }

    opts.log.push(
      `resolver attempt ${attempt}/${opts.maxAttempts} for ${source}: ${conflictedFiles.length} files`
    );

    const conflictPayloads = readConflictPayloads(workspace, conflictedFiles);

    const { agent } = createImplementerAgent(workspace);
    const result = await agent.generate(
      [
        { content: MERGE_CONFLICT_RESOLVER_PROMPT, role: 'system' },
        {
          content: JSON.stringify({
            attempt,
            conflictedFiles: conflictPayloads,
            mode: 'MERGE_CONFLICT_RESOLUTION',
            sourceBranch: source,
            targetBranch,
          }),
          role: 'user',
        },
      ],
      { toolChoice: 'auto' }
    );

    if (result.usage) {
      await recordLlmUsage(
        currentWorkflowId(),
        'implementer',
        result.usage,
        `llm.resolve_conflict.${source}.attempt_${attempt}`
      );
    }

    const remaining = listConflictedFiles(workspace);
    if (remaining.length === 0 && !hasConflictMarkers(workspace)) {
      // Stage + commit the resolution.
      workspace.exec('git add -A');
      try {
        workspace.exec(`git commit -m ${shellQuote(commitMessage)}`);
        opts.log.push(`resolved ${source} on attempt ${attempt}`);
        return { output: '', passed: true };
      } catch (commitErr) {
        // Commit can fail if the resolver re-introduced a marker via writeFile
        // or if the tree is somehow empty; fall through to retry or fail.
        opts.log.push(
          `commit after resolver failed on ${source} attempt ${attempt}: ${getExecErrorOutput(commitErr, 1000)}`
        );
      }
    } else {
      opts.log.push(
        `resolver attempt ${attempt} for ${source} left ${remaining.length} files in conflict`
      );
    }
  }

  // Resolver exhausted attempts. Abort the merge so the workspace is clean
  // for the next source (if the caller chooses to continue).
  const finalOutput = `resolver exhausted ${opts.maxAttempts} attempt(s) on ${source}; conflicts remain`;
  tryMergeAbort(workspace);
  return { output: finalOutput, passed: false };
}

function listConflictedFiles(workspace: Workspace): string[] {
  const raw = workspace.exec('git diff --name-only --diff-filter=U || true');
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readConflictPayloads(
  workspace: Workspace,
  files: string[]
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    try {
      const content = workspace.exec(`cat ${shellQuote(file)}`);
      // Truncate to keep prompt size bounded — agent will still use readFile
      // tool to pull the full content per file if it needs more.
      out.push({ content: content.slice(0, 8000), path: file });
    } catch {
      out.push({ content: '<unreadable>', path: file });
    }
  }
  return out;
}

function hasConflictMarkers(workspace: Workspace): boolean {
  try {
    workspace.exec('git diff --check');
    return false;
  } catch {
    return true;
  }
}

function tryMergeAbort(workspace: Workspace): void {
  try {
    workspace.exec('git merge --abort');
  } catch {
    /* already clean */
  }
}
