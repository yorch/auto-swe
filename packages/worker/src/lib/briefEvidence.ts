import { prisma } from '@auto-swe/shared/db';
import type { BriefEvidence } from '@auto-swe/shared/lib/prEvaluation';
import { resolveWebUrl } from '@auto-swe/shared/lib/systemConfig';
import { logWarn } from './activityLog.js';
import type { RepoRef, ScmProvider } from './scm/types.js';

/**
 * What the run that opened a pull request recorded, for the reviewer brief. Every source is read
 * on its own and a failure leaves that line unknown (null): the brief is advice, and an error here
 * must never reach the evaluation's fail-closed path. Only counts and verdicts are read, never
 * the run's notes, a command's output or an evidence caption, all of which are untrusted text.
 */

export type ReviewedOutputs = {
  codeResult?: { headSha?: unknown; openQuestionNotes?: unknown; testResults?: unknown };
  verdicts?: unknown;
};

export type LinkedReviewOutputs = { runId: string; verdicts: Record<string, unknown>[] };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function atHead(value: unknown, headSha: string): boolean {
  const code = record(value);
  return (
    code.diffVerified !== false &&
    typeof code.headSha === 'string' &&
    code.headSha.toLowerCase() === headSha.toLowerCase()
  );
}

export async function loadLinkedReviewOutputs(
  temporalWorkflowId: string,
  headSha: string,
  sourceRunId?: string | null
): Promise<LinkedReviewOutputs[]> {
  const reviews: LinkedReviewOutputs[] = [];
  let cursor: string | undefined;
  for (;;) {
    const runs = await prisma.workflowRun.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        steps: {
          orderBy: [{ endedAt: 'desc' }, { attempt: 'desc' }],
          select: { outputs: true, stepName: true },
          where: {
            OR: [
              { status: { in: ['PASSED', 'FAILED'] }, stepName: 'runReviewNetwork' },
              {
                status: 'PASSED',
                stepName: { in: ['loadChangeForReview', 'publishReviewResult'] },
              },
            ],
          },
        },
        workRequest: { select: { payload: true } },
      },
      take: 50,
      where: {
        ...(sourceRunId
          ? { reviewOfRunId: sourceRunId }
          : { reviewOfRun: { workflowId: temporalWorkflowId } }),
        status: 'SUCCESS',
      },
    });
    reviews.push(
      ...runs.flatMap((run) => {
        const mode = record(record(run.workRequest?.payload).reviewOf).mode;
        if (mode !== 'pr' && mode !== 'branch') {
          return [];
        }
        const networks = run.steps
          .filter((step) => step.stepName === 'runReviewNetwork')
          .map((step) => record(step.outputs));
        const verdicts: Record<string, unknown>[] = networks
          .filter((network) => atHead(network.codeResult, headSha))
          .flatMap((network) => {
            const values = Array.isArray(network.verdicts) ? network.verdicts.map(record) : [];
            if (network.approved === false) {
              values.push({ findings: [], severity: 'WARNING' });
            }
            return values.map((value) => ({
              ...value,
              ...(value.approved === false && value.severity !== 'CRITICAL'
                ? { severity: 'WARNING' }
                : {}),
            }));
          });
        const loaded = run.steps.find((step) => step.stepName === 'loadChangeForReview');
        const anchor = loaded ? loaded.outputs : networks[0]?.codeResult;
        if (atHead(anchor, headSha)) {
          const summary = record(
            run.steps.find((step) => step.stepName === 'publishReviewResult')?.outputs
          );
          if (typeof summary.approved === 'boolean' || typeof summary.worstSeverity === 'string') {
            verdicts.push({
              findings: Array.isArray(summary.findings) ? summary.findings.slice(0, 50) : [],
              severity:
                summary.approved === false && summary.worstSeverity !== 'CRITICAL'
                  ? 'WARNING'
                  : summary.worstSeverity,
            });
          }
        }
        return verdicts.length
          ? [
              {
                runId: run.id,
                verdicts: verdicts.map((verdict) => ({
                  ...verdict,
                  findings: Array.isArray(verdict.findings) ? verdict.findings.slice(0, 50) : [],
                  reviewer: `${typeof verdict.reviewer === 'string' ? verdict.reviewer : 'REVIEWER'} [run ${run.id}]`,
                  reviewRunId: run.id,
                })),
              },
            ]
          : [];
      })
    );
    if (runs.length < 50) {
      break;
    }
    cursor = runs.at(-1)?.id;
    if (!cursor) {
      break;
    }
  }
  return reviews;
}

function mergeLinkedVerdicts(
  original: ReviewedOutputs | null,
  linked: LinkedReviewOutputs[]
): ReviewedOutputs | null {
  if (!linked.length) {
    return original;
  }
  const verdicts = Array.isArray(original?.verdicts) ? [...original.verdicts] : [];
  const key = (finding: unknown) => {
    const f = record(finding);
    return JSON.stringify([f.file, f.line, f.category, f.description]);
  };
  const seen = new Set<string>();
  const combined = [...verdicts.map(record), ...linked.flatMap((review) => review.verdicts)];
  const rank = (verdict: Record<string, unknown>) =>
    verdict.severity === 'CRITICAL' ? 2 : verdict.severity === 'WARNING' ? 1 : 0;
  const merged = combined
    .sort((a, b) => rank(b) - rank(a))
    .map((verdict) => {
      const findings = (Array.isArray(verdict.findings) ? verdict.findings : []).filter(
        (finding) => {
          const id = key(finding);
          if (seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        }
      );
      return {
        ...verdict,
        findings: findings.map((finding) => {
          const value = record(finding);
          return typeof verdict.reviewRunId === 'string' && typeof value.description === 'string'
            ? { ...value, description: `[Review run ${verdict.reviewRunId}] ${value.description}` }
            : value;
        }),
      };
    });
  return { ...original, verdicts: merged };
}

/**
 * The outputs of the run's `runReviewNetwork` step for exactly `headSha`, or null when no such step
 * exists. The `codeResult` it reviewed names its commit, so a later push (a CI fix, a feedback
 * round, a person) matches nothing and the head has no recorded run result.
 */
export async function loadReviewedOutputs(
  temporalWorkflowId: string,
  headSha: string
): Promise<ReviewedOutputs | null> {
  const steps = await prisma.workflowStep.findMany({
    orderBy: { endedAt: 'desc' },
    select: { outputs: true },
    take: 20,
    where: {
      run: { workflowId: temporalWorkflowId },
      status: { in: ['PASSED', 'FAILED'] },
      stepName: 'runReviewNetwork',
    },
  });
  const wanted = headSha.toLowerCase();
  for (const step of steps) {
    const outputs = step.outputs as ReviewedOutputs | null;
    const reviewed = outputs?.codeResult?.headSha;
    if (typeof reviewed === 'string' && reviewed.toLowerCase() === wanted) {
      return outputs;
    }
  }
  return null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function testsOf(outputs: ReviewedOutputs | null): BriefEvidence['tests'] {
  const results = outputs?.codeResult?.testResults as
    | { failing?: unknown; passing?: unknown; total?: unknown }
    | null
    | undefined;
  if (results && isCount(results.passing) && isCount(results.failing) && isCount(results.total)) {
    return { failing: results.failing, passing: results.passing, total: results.total };
  }
  return null;
}

async function uiOf(runId: string): Promise<BriefEvidence['ui']> {
  const groups = await prisma.runEvidence.groupBy({
    _count: { _all: true },
    by: ['kind'],
    where: { runId },
  });
  const count = (kind: string) => groups.find((g) => g.kind === kind)?._count._all ?? 0;
  const ui = { screenshots: count('screenshot'), traces: count('trace'), videos: count('video') };
  return ui.screenshots + ui.traces + ui.videos === 0 ? null : ui;
}

const CI_VERDICTS = new Set(['passed', 'failed', 'pending', 'none']);

async function readOrNull<T>(
  what: string,
  meta: Record<string, unknown>,
  read: () => Promise<T>
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logWarn(`pr evaluation: ${what} could not be read for the brief`, {
      ...meta,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * The review step's outputs for exactly this head, for everything the brief takes from it, or null
 * when there are none or they cannot be read. Read once: the evidence and the findings share it.
 */
export async function loadReviewedOutputsSafe(input: {
  connectionId: string;
  headSha: string;
  prNumber: number;
  temporalWorkflowId: string;
  linkedReviews?: LinkedReviewOutputs[];
}): Promise<ReviewedOutputs | null> {
  const original = await readOrNull(
    'the run result',
    { connectionId: input.connectionId, prNumber: input.prNumber },
    () => loadReviewedOutputs(input.temporalWorkflowId, input.headSha)
  );
  const linked =
    input.linkedReviews ??
    (await readOrNull(
      'linked reviews',
      { connectionId: input.connectionId, prNumber: input.prNumber },
      () => loadLinkedReviewOutputs(input.temporalWorkflowId, input.headSha)
    )) ??
    [];
  return mergeLinkedVerdicts(original, linked);
}

export async function loadBriefEvidence(input: {
  connectionId: string;
  headSha: string;
  prNumber: number;
  repo: RepoRef;
  reviewed: ReviewedOutputs | null;
  runId: string | null;
  scm: Pick<ScmProvider, 'fetchCiStatus'>;
}): Promise<BriefEvidence> {
  const meta = { connectionId: input.connectionId, prNumber: input.prNumber };
  const [ui, ci] = await Promise.all([
    input.runId === null
      ? Promise.resolve(null)
      : readOrNull('the run evidence', meta, () => uiOf(input.runId as string)),
    readOrNull('the CI status', meta, async () => {
      const { verdict } = await input.scm.fetchCiStatus(input.repo, input.headSha);
      return CI_VERDICTS.has(verdict) ? verdict : null;
    }),
  ]);
  return {
    ci: ci as BriefEvidence['ci'],
    runUrl:
      input.runId === null
        ? null
        : `${resolveWebUrl().replace(/\/$/, '')}/runs/${encodeURIComponent(input.runId)}`,
    tests: testsOf(input.reviewed),
    ui,
  };
}
