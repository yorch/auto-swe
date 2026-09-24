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
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { planDecomposition as decomposerPlan } from '../agents/decomposer.js';
import { buildImplementerForActivity } from '../agents/implementer.js';
import { MERGE_CONFLICT_RESOLVER_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import {
  currentWorkflowId,
  currentWorkflowRunId,
  persistActivityTrace,
} from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { putArtifact } from '../lib/artifactStore.js';
import { abortSignalOption, throwIfActivityCancelled } from '../lib/cancellation.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable, recordLlmUsage } from '../lib/costTracking.js';
import { getErrorMessage, getExecErrorOutput } from '../lib/errors.js';
import { recordSuspiciousLlmOutput } from '../lib/llmOutputScan.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { recordLessonBackground } from './commitToMemory.js';
import {
  createWorkspace,
  fetchBranchesSubcommand,
  shellQuote,
  type Workspace,
} from './workspace.js';

export async function planDecomposition(
  request: RepoWorkRequest,
  systemPromptOverride?: string
): Promise<DecompositionResult> {
  heartbeat('plan decomposition: calling agent');
  const tracer = new AgentTracer();
  const activityCtx = await currentRequestContext();
  const skills = await loadAgentSkills('decomposer', activityCtx);
  const skillSuffix = skills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');

  try {
    const result = await decomposerPlan(
      request,
      tracer,
      systemPromptOverride,
      skillSuffix || undefined
    );
    return result;
  } finally {
    await persistActivityTrace(tracer, 'decomposer');
  }
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
        await workspace.exec(
          `git merge --no-ff --no-edit -m ${shellQuote(message)} origin/${shellQuote(source)}`
        );
        merged.push(source);
        log.push(`merged ${source}`);
      } catch (err: unknown) {
        const output = getExecErrorOutput(err, 4000);
        await tryMergeAbort(workspace);
        conflicts.push({ branch: source, output });
        log.push(`CONFLICT merging ${source}:\n${output.slice(-2000)}`);
        unmerged.push(...sourceBranches.slice(idx));
        break;
      }
    }

    const passed = conflicts.length === 0;
    const headSha =
      passed && merged.length > 0 ? await pushAndCapture(workspace, targetBranch, log) : undefined;

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
    await workspace.destroy(); // mergeBranches does not use an agent tracer
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
 * Replay the unmerged tail through the `mergeConflictResolver` agent. For each
 * source: attempt the merge; on conflict, invoke the resolver against the
 * conflicted files; verify the resolution ourselves — no conflict markers left
 * in any conflicted file — then stage exactly those files, confirm git holds no
 * unmerged path, and commit. The agent never runs git; staging is this
 * activity's job. After the loop, a branch the resolver touched is put through
 * the same diff scanners as every other agent-written push, and the target is
 * pushed only if every branch resolved and the security gate passed.
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
  const resolutions: ResolverCommit[] = [];

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
      if (resolved.resolution) {
        resolutions.push(resolved.resolution);
      }
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
    if (passed && resolutions.length > 0) {
      // The resolver wrote code, so its result gets the same scan every other
      // agent-written push does — before the push, so a CRITICAL finding never
      // reaches the remote branch.
      await scanResolvedMerge(workspace, resolutions, tracer);
    }
    const headSha =
      passed && merged.length > 0 ? await pushAndCapture(workspace, targetBranch, log) : undefined;

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
        rationale: `Merge-conflict resolver rewrote the conflicted files; no conflict markers remained and git reported no unmerged paths after staging.`,
        repoId: requireRepoId(request, 'resolveMergeConflict'),
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
    const done = persistActivityTrace(tracer, 'mergeConflictResolver');
    await workspace.destroy();
    await done;
  }
}

/** A merge commit the resolver produced, and the conflicted paths it wrote. */
interface ResolverCommit {
  sha: string;
  files: string[];
}

/**
 * The diff scanners every agent-written push goes through (see
 * `implementerSession.ts`): the advisory static code scan, recorded on the
 * trace, and the security gate, which fails the activity on a CRITICAL
 * finding.
 *
 * The scan covers only what the resolver wrote: for each merge commit it
 * produced, the conflicted paths diffed from the target side (`<sha>^1`) to the
 * committed resolution. Not the working tree — an edit the agent made outside
 * the conflict set is never staged or pushed — and not the default branch,
 * which would re-scan every subtask already merged into the epic and fail the
 * resolver for a finding it did not write.
 */
async function scanResolvedMerge(
  workspace: Workspace,
  resolutions: ResolverCommit[],
  tracer: AgentTracer
): Promise<void> {
  const parts: string[] = [];
  for (const { sha, files } of resolutions) {
    const paths = files.map((f) => shellQuote(f)).join(' ');
    parts.push(
      await workspace.exec(`git diff ${shellQuote(`${sha}^1`)} ${shellQuote(sha)} -- ${paths}`)
    );
  }
  const diff = parts.filter((p) => p.trim().length > 0).join('\n');
  if (diff.length === 0) {
    // The resolution kept the target side verbatim: the resolver wrote nothing.
    return;
  }

  try {
    const findings = await scanDiffForCodeIssues(diff);
    if (findings.length > 0) {
      tracer.addActivityEvent({
        name: 'code_security.scan',
        outputJson: { count: findings.length, findings },
      });
    }
  } catch (err) {
    tracer.addActivityEvent({
      error: getErrorMessage(err),
      name: 'code_security.scan',
      outputJson: { degraded: true },
    });
  }

  heartbeat('resolveMergeConflict: running security scan');
  const securityResult = await scanDiffForSecurityIssues(diff);
  if (!securityResult.passed) {
    const findingsSummary = securityResult.findings
      .map(
        (f) =>
          `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.category}: ${f.description}`
      )
      .join('\n');
    throw ApplicationFailure.nonRetryable(
      `Security scan failed with critical findings:\n${findingsSummary}`,
      'SECURITY_GATE_FAILURE',
      { findings: securityResult.findings }
    );
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
): Promise<{ workspace: Workspace; log: string[]; defaultBranch: string }> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { installationId: true } } },
    where: { id: requireRepoId(request, 'decomposition') },
  });
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  const workspace = await createWorkspace(
    authedCloneUrl,
    targetBranch,
    repo.defaultBranch,
    repo.executorImage ?? undefined
  );
  heartbeat(`${label}: workspace provisioned`);

  const log: string[] = [];
  // Explicit refspecs: the clone is single-branch, so a bare branch name
  // would land only in FETCH_HEAD and `origin/<branch>` would not exist for
  // the reset and merges below (see `fetchBranchesSubcommand`).
  const refs = [targetBranch, ...sourceBranches];
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand(refs));
    log.push(`fetched ${refs.join(', ')}`);
  } catch {
    log.push('batched fetch failed; retrying per-ref');
    for (const r of refs) {
      try {
        await workspace.gitAuthed(fetchBranchesSubcommand([r]));
        log.push(`fetched ${r}`);
      } catch {
        log.push(`fetch ${r} failed (branch may not exist remotely)`);
      }
    }
  }

  try {
    await workspace.exec(`git reset --hard origin/${shellQuote(targetBranch)}`);
    log.push(`reset to origin/${targetBranch}`);
  } catch {
    log.push(`origin/${targetBranch} not found; starting from defaultBranch`);
  }

  return { defaultBranch: repo.defaultBranch, log, workspace };
}

async function pushAndCapture(
  workspace: Workspace,
  targetBranch: string,
  log: string[]
): Promise<string> {
  // Never push on behalf of a run that has already been cancelled.
  throwIfActivityCancelled();
  await workspace.gitAuthed(`push origin ${shellQuote(targetBranch)}`);
  const headSha = (await workspace.exec('git rev-parse HEAD')).trim();
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
): Promise<{ passed: boolean; output: string; resolution?: ResolverCommit }> {
  const commitMessage = `${opts.messagePrefix}: merge ${source} into ${targetBranch}`;

  try {
    await workspace.exec(
      `git merge --no-ff --no-edit -m ${shellQuote(commitMessage)} origin/${shellQuote(source)}`
    );
    opts.log.push(`merged ${source} cleanly`);
    return { output: '', passed: true };
  } catch (err) {
    opts.log.push(
      `conflict on ${source}: ${getExecErrorOutput(err, 800).slice(-400)}; invoking resolver`
    );
  }

  // The conflict set is fixed by the merge. Nothing is staged until every file
  // in it is clean, so git keeps reporting the same unmerged paths across
  // attempts — read it once.
  let conflictedFiles: string[];
  try {
    conflictedFiles = await listConflictedFiles(workspace);
  } catch (err) {
    await tryMergeAbort(workspace);
    return {
      output: `could not list conflicted files: ${getExecErrorOutput(err, 800)}`,
      passed: false,
    };
  }
  if (conflictedFiles.length === 0) {
    // Merge threw without leaving unmerged stages — non-conflict failure
    // (dirty tree, lock, etc.). Abort + surface so the run doesn't loop.
    await tryMergeAbort(workspace);
    return { output: 'merge failed without conflicted files', passed: false };
  }

  const activityCtx = await currentRequestContext();
  const systemPrompt = await resolveSystemPrompt(
    'mergeConflictResolver',
    MERGE_CONFLICT_RESOLVER_PROMPT
  );

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    throwIfActivityCancelled();
    opts.log.push(
      `resolver attempt ${attempt}/${opts.maxAttempts} for ${source}: ${conflictedFiles.length} files`
    );

    const { agent, promptSuffix, closeMcp, maxSteps } = await buildImplementerForActivity(
      workspace,
      opts.tracer,
      activityCtx,
      'mergeConflictResolver'
    );
    const fullSystemPrompt = systemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : '');
    const userMessage = JSON.stringify({
      attempt,
      conflictedFiles: await readConflictPayloads(workspace, conflictedFiles),
      sourceBranch: source,
      targetBranch,
    });
    const start = Date.now();
    try {
      await assertBudgetAvailable('decomposition');
      const result = await agent.generate(
        [
          { content: fullSystemPrompt, role: 'system' },
          { content: userMessage, role: 'user' },
        ],
        { maxSteps, toolChoice: 'auto', ...abortSignalOption() }
      );

      let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
      if (result.usage) {
        attribution = await recordLlmUsage(
          currentWorkflowId(),
          'mergeConflictResolver',
          result.usage,
          `llm.resolve_conflict.${source}.attempt_${attempt}`
        );
      }

      // LLM output scanner — advisory, non-blocking (the helper never throws).
      await recordSuspiciousLlmOutput(opts.tracer, result.text ?? '', {
        inputJson: { attempt, source },
      });

      // Recorded even when the model only made tool calls: the tool calls are
      // already on the tracer, and this is the row that carries the prompt,
      // the cost, and the attempt they belong to.
      opts.tracer.addLlmResponse({
        costUsd: attribution.costUsd,
        durationMs: Date.now() - start,
        inputJson: { attempt, source, systemPrompt: fullSystemPrompt, userMessage },
        inputTokens: attribution.inputTokens,
        model: attribution.modelSpec || undefined,
        outputJson: result.text
          ? { text: result.text }
          : { toolCallCount: result.steps?.length ?? 0 },
        outputTokens: attribution.outputTokens,
        role: 'mergeConflictResolver',
      });
    } catch (err) {
      opts.tracer.addLlmResponse({
        durationMs: Date.now() - start,
        error: getErrorMessage(err),
        inputJson: { attempt, source, systemPrompt: fullSystemPrompt, userMessage },
        role: 'mergeConflictResolver',
      });
      throw err;
    } finally {
      await closeMcp?.();
    }

    const withMarkers = await filesWithConflictMarkers(workspace, conflictedFiles);
    if (withMarkers.length > 0) {
      opts.log.push(
        `resolver attempt ${attempt} for ${source} left conflict markers in ${withMarkers.length} file(s): ${withMarkers.join(', ')}`
      );
      continue;
    }

    try {
      // Stage exactly the conflicted paths: `git add` is what clears an
      // unmerged index entry, and a path the resolver deleted is staged as a
      // removal. Anything else the agent touched stays out of the commit.
      await workspace.exec(`git add -- ${conflictedFiles.map((f) => shellQuote(f)).join(' ')}`);
      const stillUnmerged = await listConflictedFiles(workspace);
      if (stillUnmerged.length > 0) {
        opts.log.push(
          `resolver attempt ${attempt} for ${source}: ${stillUnmerged.length} path(s) still unmerged after staging`
        );
        continue;
      }
      await workspace.exec(`git commit -m ${shellQuote(commitMessage)}`);
      const sha = (await workspace.exec('git rev-parse HEAD')).trim();
      opts.log.push(`resolved ${source} on attempt ${attempt} (${sha})`);
      return { output: '', passed: true, resolution: { files: conflictedFiles, sha } };
    } catch (commitErr) {
      opts.log.push(
        `staging/commit after resolver failed on ${source} attempt ${attempt}: ${getExecErrorOutput(commitErr, 1000)}`
      );
    }
  }

  await tryMergeAbort(workspace);
  return {
    output: `resolver exhausted ${opts.maxAttempts} attempt(s) on ${source}; conflicts remain`,
    passed: false,
  };
}

/**
 * The paths git holds as unmerged. `-z` is load-bearing: without it git
 * C-quotes any path with a space-adjacent, non-ASCII or control character
 * (`"caf\303\251.md"`), and the quoted form names no file on disk. Entries are
 * NUL-separated and taken verbatim — never trimmed, since a leading or trailing
 * space is part of a path. A failing `git diff` throws rather than reading as
 * "nothing unmerged", which is the answer that would let a merge be committed.
 */
export async function listConflictedFiles(workspace: Workspace): Promise<string[]> {
  const raw = await workspace.exec('git diff --name-only -z --diff-filter=U');
  return [...new Set(raw.split('\0').filter((s) => s.length > 0))];
}

async function readConflictPayloads(
  workspace: Workspace,
  files: string[]
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    try {
      const content = await workspace.exec(`cat ${shellQuote(file)}`);
      // Truncated per file — the agent can pull more via readFile if needed.
      out.push({ content: content.slice(0, 8000), path: file });
    } catch {
      out.push({ content: '<unreadable>', path: file });
    }
  }
  return out;
}

/**
 * A line that opens or closes a conflict hunk: `<<<<<<< ours`, `>>>>>>> theirs`,
 * and the diff3 base marker `||||||| base` — exactly seven characters, then a
 * space or the end of the line, so a `<<<` heredoc or an 8-character rule does
 * not match.
 *
 * The `=======` separator is deliberately absent. It is the Markdown and
 * reStructuredText setext underline for a seven-letter heading (`License`,
 * `Changes`), so matching it bare fails every merge that touches such a README.
 * It is also redundant: git never writes a separator without the opening and
 * closing markers around it, and a file still holding either is already caught.
 */
export const CONFLICT_MARKER_ERE = '^(<{7}|>{7}|[|]{7})( |$)';

/**
 * The conflicted files that still contain a conflict marker in the working
 * tree. `git diff --check` is not a substitute: it inspects unstaged changes
 * only, and it also fails on trailing whitespace, which is not a conflict. A
 * file the resolver deleted has no markers. A grep that cannot run at all
 * (exit ≥ 2 on a file that exists) counts as markers present — an unverified
 * file is not a resolved one.
 */
async function filesWithConflictMarkers(workspace: Workspace, files: string[]): Promise<string[]> {
  const dirty: string[] = [];
  for (const file of files) {
    const quoted = shellQuote(file);
    const res = await workspace.execCapture(
      `if [ -e ${quoted} ]; then grep -qE ${shellQuote(CONFLICT_MARKER_ERE)} -- ${quoted}; else exit 1; fi`
    );
    // grep: 0 = a marker line matched, 1 = none, ≥2 = error.
    if (res.exitCode !== 1) {
      dirty.push(file);
    }
  }
  return dirty;
}

async function tryMergeAbort(workspace: Workspace): Promise<void> {
  try {
    await workspace.exec('git merge --abort');
  } catch {
    /* already clean */
  }
}
