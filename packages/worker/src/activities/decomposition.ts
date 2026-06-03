/**
 * Feature-level decomposition + branch-merging activities.
 *
 *   planDecomposition    — calls the decomposer agent and returns Subtask[]
 *   mergeBranches        — merges N subtask branches into the parent feature
 *                          branch. Aborts on conflict and exposes the unmerged
 *                          tail so a downstream resolver can pick up.
 *   resolveMergeConflict — replays the unmerged tail through the implementer
 *                          agent to rewrite conflict markers, then commits + pushes.
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
import {
  currentWorkflowId,
  currentWorkflowRunId,
  persistImplementerTrace,
} from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { putArtifact } from '../lib/artifactStore.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorOutput, requireEnv } from '../lib/errors.js';
import { recordLessonBackground } from './commitToMemory.js';
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

  const messagePrefix = input.mergeMessagePrefix ?? 'auto-merge';
  const { workspace, log } = await provisionMergeWorkspace(
    request,
    targetBranch,
    sourceBranches,
    'mergeBranches'
  );
  const merged: string[] = [];
  const unmerged: string[] = [];
  const conflicts: Array<{ branch: string; output: string }> = [];

  try {
    for (let idx = 0; idx < sourceBranches.length; idx++) {
      const source = sourceBranches[idx] as string;
      heartbeat(`mergeBranches: merging ${source}`);
      const message = `${messagePrefix}: merge ${source} into ${targetBranch}`;
      try {
        workspace.exec(
          `git merge --no-ff --no-edit -m ${shellQuote(message)} origin/${shellQuote(source)}`
        );
        merged.push(source);
        log.push(`merged ${source}`);
      } catch (err: unknown) {
        const output = getExecErrorOutput(err, 4000);
        tryMergeAbort(workspace);
        conflicts.push({ branch: source, output });
        log.push(`CONFLICT merging ${source}:\n${output.slice(-2000)}`);
        unmerged.push(...sourceBranches.slice(idx));
        break;
      }
    }

    const passed = conflicts.length === 0;
    const headSha =
      passed && merged.length > 0 ? pushAndCapture(workspace, targetBranch, log) : undefined;

    const artifact = await putArtifact({
      body: log.join('\n'),
      contentType: 'text/plain; charset=utf-8',
      kind: 'merge.log',
      runId: await currentWorkflowRunId(),
    }).catch(() => null);

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
    workspace.destroy(); // mergeBranches does not use an agent tracer
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
 * Replay the unmerged tail through the implementer agent. For each source:
 * attempt the merge; on conflict, invoke the resolver agent against the
 * conflicted files; verify the resolution via `git diff --diff-filter=U`
 * (unmerged stages) + `git diff --check` (working-tree markers); stage +
 * commit. After the loop, push the target if every branch resolved.
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

  const rawAttempts = input.maxAttemptsPerBranch;
  // Guard against NaN / Infinity / 0 / negatives — any of those would silently
  // skip every attempt and report an exhausted-NaN counter.
  const maxAttemptsPerBranch =
    typeof rawAttempts === 'number' && Number.isFinite(rawAttempts) && rawAttempts >= 1
      ? Math.floor(rawAttempts)
      : 1;
  const messagePrefix = input.mergeMessagePrefix ?? 'auto-merge';

  const { workspace, log } = await provisionMergeWorkspace(
    request,
    targetBranch,
    sourceBranches,
    'resolveMergeConflict'
  );
  const merged: string[] = [];
  const unmerged: string[] = [];
  const conflicts: Array<{ branch: string; output: string }> = [];
  const tracer = new AgentTracer();

  try {
    for (let idx = 0; idx < sourceBranches.length; idx++) {
      const source = sourceBranches[idx] as string;
      heartbeat(`resolveMergeConflict: merging ${source}`);
      const resolved = await mergeOneWithResolver(workspace, source, targetBranch, {
        log,
        maxAttempts: maxAttemptsPerBranch,
        messagePrefix,
        tracer,
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

    const passed = conflicts.length === 0;
    const headSha =
      passed && merged.length > 0 ? pushAndCapture(workspace, targetBranch, log) : undefined;

    const artifact = await putArtifact({
      body: log.join('\n'),
      contentType: 'text/plain; charset=utf-8',
      kind: 'merge.resolve.log',
      runId: await currentWorkflowRunId(),
    }).catch(() => null);

    const summary = passed
      ? `resolved + merged ${merged.length}/${sourceBranches.length} branches into ${targetBranch}`
      : `conflict resolution failed at ${conflicts[0]?.branch}: ${conflicts[0]?.output.slice(0, 400)}`;

    // Phase-8 memory hook: a successful resolver run is exactly the kind of
    // outcome `commitToMemory` should capture. We bypass the LLM summarizer
    // (the resolver already knows what happened) and write a direct lesson
    // pointing at the resolved branches. Failures aren't recorded — the
    // run's FAILED row already tells that story.
    if (passed && merged.length > 0) {
      // recordLessonBackground caps wall-clock at 5s so a slow embedding
      // provider can't drag the resolver activity past its timeout once the
      // real work (merge + push) has already succeeded.
      await recordLessonBackground({
        failureType: 'MERGE_CONFLICT',
        lessonSummary: `Auto-resolved merge conflicts when merging ${merged.length} branch(es) into ${targetBranch}: ${merged.join(', ')}`,
        metadata: { mergedBranches: merged, targetBranch },
        rationale: `Implementer agent rewrote conflict markers and the resolution passed git diff --check + diff-filter=U.`,
        repoId: request.repoId,
        temporalWorkflowId: currentWorkflowId(),
      });
    }

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
    const done = persistImplementerTrace(tracer);
    workspace.destroy();
    await done;
  }
}

/**
 * Provision a workspace at `targetBranch`, batch-fetch every relevant ref
 * (falling back to per-ref on failure so we still pick up whatever exists),
 * and hard-reset to the remote target. Shared by mergeBranches +
 * resolveMergeConflict — both want the same starting state.
 */
async function provisionMergeWorkspace(
  request: RepoWorkRequest,
  targetBranch: string,
  sourceBranches: string[],
  label: string
): Promise<{ workspace: Workspace; log: string[] }> {
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
  heartbeat(`${label}: workspace provisioned`);

  const log: string[] = [];
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

  return { log, workspace };
}

function pushAndCapture(workspace: Workspace, targetBranch: string, log: string[]): string {
  workspace.exec(`git push origin ${shellQuote(targetBranch)}`);
  const headSha = workspace.exec('git rev-parse HEAD').trim();
  log.push(`pushed ${targetBranch} (head ${headSha})`);
  return headSha;
}

async function mergeOneWithResolver(
  workspace: Workspace,
  source: string,
  targetBranch: string,
  opts: {
    log: string[];
    maxAttempts: number;
    messagePrefix: string;
    tracer: AgentTracer;
  }
): Promise<{ passed: boolean; output: string }> {
  const commitMessage = `${opts.messagePrefix}: merge ${source} into ${targetBranch}`;

  try {
    workspace.exec(
      `git merge --no-ff --no-edit -m ${shellQuote(commitMessage)} origin/${shellQuote(source)}`
    );
    opts.log.push(`merged ${source} cleanly`);
    return { output: '', passed: true };
  } catch (err) {
    opts.log.push(
      `conflict on ${source}: ${getExecErrorOutput(err, 800).slice(-400)}; invoking resolver`
    );
  }

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const conflictedFiles = listConflictedFiles(workspace);
    if (conflictedFiles.length === 0) {
      // Merge threw without leaving unmerged stages — non-conflict failure
      // (dirty tree, lock, etc.). Abort + surface so the run doesn't loop.
      tryMergeAbort(workspace);
      return { output: 'merge failed without conflicted files', passed: false };
    }

    opts.log.push(
      `resolver attempt ${attempt}/${opts.maxAttempts} for ${source}: ${conflictedFiles.length} files`
    );

    const { agent } = await createImplementerAgent(workspace, opts.tracer);
    const result = await agent.generate(
      [
        { content: MERGE_CONFLICT_RESOLVER_PROMPT, role: 'system' },
        {
          content: JSON.stringify({
            attempt,
            conflictedFiles: readConflictPayloads(workspace, conflictedFiles),
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
      workspace.exec('git add -A');
      try {
        workspace.exec(`git commit -m ${shellQuote(commitMessage)}`);
        opts.log.push(`resolved ${source} on attempt ${attempt}`);
        return { output: '', passed: true };
      } catch (commitErr) {
        // Resolver may have re-introduced a marker via writeFile or staged
        // an empty tree; fall through to retry or terminal failure.
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

  tryMergeAbort(workspace);
  return {
    output: `resolver exhausted ${opts.maxAttempts} attempt(s) on ${source}; conflicts remain`,
    passed: false,
  };
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
      // Truncated per file — the agent can pull more via readFile if needed.
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
