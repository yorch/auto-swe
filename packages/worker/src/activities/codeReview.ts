import { randomBytes } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import {
  REVIEW_COMMENT_MARKER_PREFIX,
  REVIEW_HARD_MAX_DIFF_CHARS,
  type ReviewRunPayload,
  ReviewRunPayloadSchema,
} from '@auto-swe/shared/lib/codeReview';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { BaseBranchSchema } from '@auto-swe/shared/lib/gitRef';
import {
  PR_EVALUATION_WORKFLOW_TYPE,
  prEvaluationWorkflowId,
} from '@auto-swe/shared/lib/prEvaluationWorkflow';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import type {
  AggregatedReviewResult,
  CodeResult,
  RepoWorkRequest,
  ReviewFinding,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { currentWorkflowRunId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, type RepoRef, type ScmProvider, toRepoRef } from '../lib/scm/index.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import type { QodoReviewResult } from './awaitQodoReview.js';
import { neutralizeCommentText } from './ciTriage.js';
import { runReviewTestGate } from './qualityGates.js';
import { type ReviewFixResult, startReviewFix } from './reviewFixes.js';
import { parseDiffToFileChanges } from './utils.js';
import { createWorkspace, fetchBranchesSubcommand, shellQuote } from './workspace.js';

const GIT =
  'GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git ' +
  '-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null ' +
  '-c core.autocrlf=false -c commit.gpgsign=false';
const SHA = z.string().regex(/^[a-fA-F0-9]{40}$/);
const MAX_FINDINGS = 20;
const SEVERITIES = ['PASS', 'INFO', 'WARNING', 'CRITICAL'] as const;
type Severity = (typeof SEVERITIES)[number];

export interface ReviewChange extends CodeResult {
  diffVerified: boolean;
  prUrl?: string;
}

function refuse(code: string, message: string): never {
  throw ApplicationFailure.nonRetryable(message, code);
}

function payloadOf(request: RepoWorkRequest): ReviewRunPayload {
  const payload = ReviewRunPayloadSchema.safeParse(request.payload);
  if (!payload.success) {
    return refuse('REVIEW_INVALID_PAYLOAD', 'Invalid review run payload');
  }
  if (requireRepoId(request, 'code review') !== payload.data.connectionId) {
    return refuse('REVIEW_CONNECTION_MISMATCH', 'Review payload names a different repository');
  }
  return payload.data;
}

async function loadRepo(id: string) {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id },
  });
  if (repo.type !== 'git_repo') {
    return refuse('REVIEW_NOTHING_TO_REVIEW', 'Code reviews require a Git repository');
  }
  return repo;
}

const StoredResultSchema = z.object({
  deliver: z.literal('none'),
  diff: z.string(),
  diffTruncated: z.boolean().optional(),
});

async function loadStored(sourceRunId: string, repoId: string): Promise<string> {
  const source = await prisma.workflowRun.findUnique({
    include: {
      steps: {
        orderBy: { endedAt: 'desc' },
        take: 1,
        where: { status: 'PASSED', stepName: 'runAgentTask' },
      },
      template: { select: { origin: true, teamId: true } },
      workRequest: { select: { connectionId: true } },
    },
    where: { id: sourceRunId },
  });
  if (
    !source?.endedAt ||
    source.reviewOfRunId ||
    source.template.teamId !== null ||
    source.template.origin !== AGENT_RUN_TEMPLATE_ORIGIN ||
    (source.connectionId ?? source.workRequest?.connectionId) !== repoId
  ) {
    return refuse(
      'REVIEW_NOTHING_TO_REVIEW',
      'Source is not a finished agent run on this repository'
    );
  }
  const snapshot = source.contextSnapshot as { result?: unknown } | null;
  const parsed = StoredResultSchema.safeParse(snapshot?.result ?? source.steps[0]?.outputs);
  if (!parsed.success || !parsed.data.diff.trim()) {
    return refuse('REVIEW_NOTHING_TO_REVIEW', 'Source has no stored agent diff');
  }
  if (parsed.data.diffTruncated) {
    return refuse('REVIEW_DIFF_TOO_LARGE', 'The source agent diff was truncated');
  }
  return parsed.data.diff;
}

export interface LoadReviewDeps {
  loadRepo: typeof loadRepo;
  loadStored: typeof loadStored;
  scm: (repo: RepoRef) => ScmProvider;
  createWorkspace: typeof createWorkspace;
}

export async function loadChangeForReviewWith(
  request: RepoWorkRequest,
  deps: LoadReviewDeps
): Promise<ReviewChange> {
  const payload = payloadOf(request);
  const noTests = {
    duration_ms: 0,
    failing: 0,
    passed: false,
    passing: 0,
    stdout: 'Tests not run (review only).',
    total: 0,
  };
  const finish = (
    diff: string,
    identity: Pick<ReviewChange, 'branch' | 'headSha' | 'diffVerified'> & Partial<ReviewChange>
  ): ReviewChange => {
    if (diff.length > REVIEW_HARD_MAX_DIFF_CHARS) {
      return refuse(
        'REVIEW_DIFF_TOO_LARGE',
        `Review diff exceeds ${REVIEW_HARD_MAX_DIFF_CHARS} characters`
      );
    }
    const result = {
      implementationNotes: identity.diffVerified
        ? 'Read-only review of the published change.'
        : 'UNVERIFIED stored agent diff; no published commit was verified.',
      repoId: payload.connectionId,
      ...identity,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: identity.testResults ?? noTests,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 1_200_000) {
      return refuse('REVIEW_DIFF_TOO_LARGE', 'Review change exceeds the 1.2 MB payload hard cap');
    }
    return result;
  };
  if (payload.reviewOf.mode === 'stored') {
    return finish(await deps.loadStored(payload.sourceRunId, payload.connectionId), {
      branch: '',
      diffVerified: false,
      headSha: '',
    });
  }
  const repo = await deps.loadRepo(payload.connectionId);
  const ref = toRepoRef(repo);
  const scm = deps.scm(ref);
  let branch: string;
  let baseBranch: string;
  let headSha: string;
  let prUrl: string | undefined;
  if (payload.reviewOf.mode === 'pr') {
    const pr = await scm.pullRequestInfo(ref, payload.reviewOf.prNumber);
    if (pr?.state !== 'open' || pr.merged) {
      return refuse('REVIEW_PR_CLOSED', 'The pull request is no longer open');
    }
    if (
      pr.headRepositoryFullName?.toLowerCase() !==
      `${ref.organizationName}/${ref.repoName}`.toLowerCase()
    ) {
      return refuse('REVIEW_PR_FORK', 'Reviewing fork pull requests is not supported');
    }
    branch = BaseBranchSchema.parse(pr.headRef);
    baseBranch = BaseBranchSchema.parse(pr.baseRef);
    headSha = SHA.parse(pr.headSha).toLowerCase();
    prUrl = pr.htmlUrl;
  } else {
    branch = payload.reviewOf.branch;
    baseBranch = BaseBranchSchema.parse(payload.reviewOf.baseBranch ?? repo.defaultBranch);
    headSha = payload.reviewOf.headSha.toLowerCase();
  }
  const { authedCloneUrl } = await scm.cloneCredentials(ref);
  const workspace = await deps.createWorkspace(
    authedCloneUrl,
    branch,
    baseBranch,
    executorImageFor(repo),
    payload.reviewOf.mode === 'pr' ? headSha : undefined,
    payload.reviewOf.mode === 'branch',
    { detectedStack: repo.detectedStack, repoSetup: { field: repo.setup }, teamId: repo.teamId }
  );
  try {
    const actual = (await workspace.exec(`${GIT} rev-parse HEAD`)).trim().toLowerCase();
    if (actual !== headSha) {
      return refuse(
        'REVIEW_HEAD_CHANGED',
        'The branch head changed; start a new review of the current commit'
      );
    }
    await workspace.gitAuthed(`fetch --unshallow origin`).catch(async () => {
      // A pinned checkout already has full history.
      const shallow = (await workspace.exec(`${GIT} rev-parse --is-shallow-repository`)).trim();
      if (shallow === 'true') {
        return refuse('REVIEW_HISTORY_UNAVAILABLE', 'Could not fetch full history for the review');
      }
    });
    await workspace.gitAuthed(fetchBranchesSubcommand([baseBranch]));
    const baseSha = SHA.parse(
      (
        await workspace.exec(
          `${GIT} merge-base HEAD ${shellQuote(`refs/remotes/origin/${baseBranch}`)}`
        )
      ).trim()
    );
    const diff = await workspace.exec(
      `${GIT} diff --text --no-textconv --no-ext-diff --no-color --no-renames ${shellQuote(baseSha)} ${shellQuote(headSha)}`
    );
    return finish(diff, {
      baseBranch,
      baseSha,
      branch,
      diffVerified: true,
      headSha,
      ...(payload.runTests ? { testResults: await runReviewTestGate(workspace, repo) } : {}),
      ...(prUrl ? { prUrl } : {}),
    });
  } finally {
    await workspace.destroy();
  }
}

export async function loadChangeForReview(request: RepoWorkRequest): Promise<ReviewChange> {
  return withHeartbeat(
    'loadChangeForReview',
    loadChangeForReviewWith(request, { createWorkspace, loadRepo, loadStored, scm: getScmProvider })
  );
}

export interface PublishReviewInput {
  request: RepoWorkRequest;
  review?: AggregatedReviewResult;
  qodo?: QodoReviewResult;
  human?: { feedback?: string; decision?: string };
}

export interface ReviewSummary {
  fix?: ReviewFixResult;
  approved: boolean;
  worstSeverity: Severity;
  findingCount: number;
  findings: ReviewFinding[];
  humanNote?: string;
}

export interface PublishReviewDeps {
  runId: () => Promise<string | undefined>;
  loadRepo: typeof loadRepo;
  scm: (repo: RepoRef) => ScmProvider;
  webUrl: () => string;
  reevaluate: (payload: ReviewRunPayload, runId: string) => Promise<void>;
  requestReviewFix: (
    payload: ReviewRunPayload,
    summary: ReviewSummary,
    runId: string
  ) => Promise<ReviewFixResult | undefined>;
}

export async function requestReviewReevaluation(
  payload: ReviewRunPayload,
  runId: string
): Promise<void> {
  if (payload.reviewOf.mode !== 'pr') {
    return;
  }
  await getTemporalClient().workflow.start(PR_EVALUATION_WORKFLOW_TYPE, {
    args: [
      {
        connectionId: payload.connectionId,
        prNumber: payload.reviewOf.prNumber,
        reviewRunId: runId,
        trigger: 'review_run',
      },
    ],
    taskQueue: 'engineering-workflow',
    workflowId: prEvaluationWorkflowId(
      payload.connectionId,
      payload.reviewOf.prNumber,
      `${randomBytes(4).toString('hex')}${runId}`
    ),
  });
}

export async function requestReviewFix(
  payload: ReviewRunPayload,
  summary: ReviewSummary,
  runId: string
): Promise<ReviewFixResult> {
  if (payload.onBlocking !== 'fix' || payload.reviewOf.mode !== 'pr' || summary.approved) {
    return { reason: 'the review does not request a pull request fix', status: 'skipped' };
  }
  return startReviewFix(payload, runId);
}

export async function publishReviewResultWith(
  input: PublishReviewInput,
  deps: PublishReviewDeps,
  tracer: AgentTracer
): Promise<ReviewSummary> {
  const payload = payloadOf(input.request);
  if (!input.review && !input.human) {
    return refuse(
      'REVIEW_RESULT_MISSING',
      'Review publication requires agent verdicts or a human decision'
    );
  }
  let approved = input.review
    ? input.review.approved && input.review.verdicts.every((v) => v.approved)
    : true;
  let worstSeverity: Severity = 'PASS';
  for (const verdict of input.review?.verdicts ?? []) {
    if (SEVERITIES.indexOf(verdict.severity) > SEVERITIES.indexOf(worstSeverity)) {
      worstSeverity = verdict.severity;
    }
  }
  const findings = (input.review?.verdicts ?? []).flatMap((v) => v.findings);
  const currentQodo =
    input.qodo?.status === 'reviewed' &&
    input.qodo.headMatches &&
    input.qodo.reviewedHeadSha === input.review?.codeResult.headSha
      ? input.qodo
      : undefined;
  if (currentQodo) {
    if (currentQodo.counts.actionRequired > 0) {
      approved = false;
    }
    const qodoSeverity =
      currentQodo.counts.actionRequired > 0
        ? 'CRITICAL'
        : currentQodo.counts.remediationRecommended > 0
          ? 'WARNING'
          : currentQodo.counts.informational > 0
            ? 'INFO'
            : 'PASS';
    if (SEVERITIES.indexOf(qodoSeverity) > SEVERITIES.indexOf(worstSeverity)) {
      worstSeverity = qodoSeverity;
    }
    for (const finding of currentQodo.findings) {
      findings.push({
        category: 'Qodo',
        description: `${finding.title}: ${finding.description}`,
        file: '',
        suggestedFix: '',
      });
    }
  }
  if (input.human?.decision === 'request-changes') {
    approved = false;
    if (worstSeverity !== 'CRITICAL') {
      worstSeverity = 'WARNING';
    }
  }
  const summary: ReviewSummary = {
    approved,
    findingCount:
      (input.review?.verdicts ?? []).reduce((n, v) => n + v.findings.length, 0) +
      (currentQodo?.counts.open ?? 0),
    findings: findings.slice(0, MAX_FINDINGS).map((f) => ({
      category: f.category.slice(0, 100),
      description: f.description.slice(0, 1200),
      file: f.file.slice(0, 300),
      ...(f.line !== undefined ? { line: f.line } : {}),
      suggestedFix: f.suggestedFix.slice(0, 500),
    })),
    ...(input.human?.feedback ? { humanNote: input.human.feedback.slice(0, 4000) } : {}),
    worstSeverity,
  };
  const runId = await deps.runId();
  if (!runId) {
    return refuse('REVIEW_RUN_MISSING', 'Review run identity is unavailable');
  }
  if (payload.onBlocking === 'fix' && payload.reviewOf.mode === 'pr' && !approved) {
    try {
      const fix = await deps.requestReviewFix(payload, summary, runId);
      if (fix) {
        summary.fix = fix;
      }
    } catch {
      summary.fix = { reason: 'the fix launch failed', status: 'skipped' };
    }
    if (summary.fix) {
      tracer.addActivityEvent({
        name: `code_review.fix_${summary.fix.status}`,
        outputJson: { runId, ...summary.fix },
      });
    }
  }
  if (payload.reviewOf.mode === 'pr') {
    const repo = await deps.loadRepo(payload.connectionId);
    const ref = toRepoRef(repo);
    const marker = `${REVIEW_COMMENT_MARKER_PREFIX}${runId} -->`;
    const url = `${deps.webUrl().replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}`;
    const lines = [
      marker,
      `## Code review: ${approved ? 'approved' : 'changes requested'}`,
      `Severity: **${worstSeverity}** · ${summary.findingCount} finding(s)`,
      `[View review run](${url})`,
    ];
    for (const finding of summary.findings) {
      lines.push(
        `- ${neutralizeCommentText(finding.file, 300)}: ${neutralizeCommentText(finding.description, 1500)}${finding.suggestedFix ? ` — ${neutralizeCommentText(finding.suggestedFix, 1000)}` : ''}`
      );
    }
    if (summary.humanNote) {
      lines.push(`Reviewer note: ${neutralizeCommentText(summary.humanNote, 4000)}`);
    }
    if (summary.fix?.status === 'skipped') {
      lines.push(`fix not started: ${neutralizeCommentText(summary.fix.reason, 1000)}`);
    }
    if (summary.fix?.status === 'started') {
      lines.push(`Fix round started: ${neutralizeCommentText(summary.fix.workflowId, 200)}`);
    }
    const markdown = lines.join('\n\n');
    const bounded =
      markdown.length > 60_000
        ? `${markdown.slice(0, 59_000)}\n\nAdditional findings omitted; see the review run.`
        : markdown;
    await deps.scm(ref).upsertMarkedComment(ref, payload.reviewOf.prNumber, marker, bounded);
    try {
      await deps.reevaluate(payload, runId);
    } catch {
      tracer.addActivityEvent({ name: 'code_review.reevaluation_failed', outputJson: { runId } });
    }
  }
  return summary;
}

export async function publishReviewResult(input: PublishReviewInput): Promise<ReviewSummary> {
  const tracer = new AgentTracer();
  try {
    return await withHeartbeat(
      'publishReviewResult',
      publishReviewResultWith(
        input,
        {
          loadRepo,
          reevaluate: requestReviewReevaluation,
          requestReviewFix,
          runId: currentWorkflowRunId,
          scm: getScmProvider,
          webUrl: resolveWebUrl,
        },
        tracer
      )
    );
  } finally {
    await persistActivityTrace(tracer, 'reviewer');
  }
}
