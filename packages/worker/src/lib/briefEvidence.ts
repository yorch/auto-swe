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

type ReviewedOutputs = {
  codeResult?: { headSha?: unknown; testResults?: unknown };
  verdicts?: unknown;
};

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

export async function loadBriefEvidence(input: {
  connectionId: string;
  headSha: string;
  prNumber: number;
  repo: RepoRef;
  runId: string | null;
  scm: Pick<ScmProvider, 'fetchCiStatus'>;
  temporalWorkflowId: string;
}): Promise<BriefEvidence> {
  const meta = { connectionId: input.connectionId, prNumber: input.prNumber };
  const [reviewed, ui, ci] = await Promise.all([
    readOrNull('the run result', meta, () =>
      loadReviewedOutputs(input.temporalWorkflowId, input.headSha)
    ),
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
    tests: testsOf(reviewed),
    ui,
  };
}
