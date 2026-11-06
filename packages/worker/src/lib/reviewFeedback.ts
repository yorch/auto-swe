import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import { ReviewRunPayloadSchema } from '@auto-swe/shared/lib/codeReview';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function reviewFeedbackSubject(
  prNumber: number,
  runId: string,
  attemptId?: unknown
): string {
  return `pr-${prNumber}@review-${runId}${typeof attemptId === 'string' ? `:attempt-${attemptId}` : ''}`;
}

interface ReviewFeedback {
  approved: unknown;
  headSha: string;
  origin: 'agent_run' | 'workflow';
  sourceRunId: string;
  sourceWorkflowId: string;
  status: string;
  texts: string[];
}

export async function readReviewFeedback(
  runId: string,
  connectionId: string,
  prNumber: number
): Promise<ReviewFeedback | null> {
  const run = await prisma.workflowRun.findUnique({
    include: {
      reviewOfRun: {
        select: { template: { select: { origin: true, teamId: true } }, workflowId: true },
      },
      steps: {
        orderBy: [{ endedAt: 'desc' }, { attempt: 'desc' }],
        where: {
          status: { in: ['PASSED', 'FAILED'] },
          stepName: { in: ['loadChangeForReview', 'runReviewNetwork', 'publishReviewResult'] },
        },
      },
      template: { select: { kind: true } },
      workRequest: { select: { payload: true } },
    },
    where: { id: runId },
  });
  const payload = ReviewRunPayloadSchema.safeParse(run?.workRequest?.payload);
  if (
    !run?.reviewOfRun ||
    run.template.kind !== 'review' ||
    !payload.success ||
    payload.data.onBlocking !== 'fix' ||
    payload.data.connectionId !== connectionId ||
    payload.data.reviewOf.mode !== 'pr' ||
    payload.data.reviewOf.prNumber !== prNumber ||
    run.reviewOfRunId !== payload.data.sourceRunId ||
    !['RUNNING', 'SUCCESS'].includes(run.status)
  ) {
    return null;
  }
  const loaded = object(
    run.steps.find((s) => s.stepName === 'loadChangeForReview' && s.status === 'PASSED')?.outputs
  );
  const networks = run.steps
    .filter((s) => s.stepName === 'runReviewNetwork')
    .map((s) => object(s.outputs));
  const code = Object.keys(loaded).length ? loaded : object(networks[0]?.codeResult);
  if (
    code.diffVerified === false ||
    typeof code.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(code.headSha)
  ) {
    return null;
  }
  const summary = object(
    run.steps.find((s) => s.stepName === 'publishReviewResult' && s.status === 'PASSED')?.outputs
  );
  const findings: unknown[] = [];
  for (const network of networks) {
    if (object(network.codeResult).headSha !== code.headSha || !Array.isArray(network.verdicts)) {
      continue;
    }
    for (const verdict of network.verdicts) {
      const v = object(verdict);
      if (
        Array.isArray(v.findings) &&
        (v.severity === 'WARNING' || v.severity === 'CRITICAL' || v.approved === false)
      ) {
        findings.push(...v.findings.slice(0, 100));
      }
    }
  }
  if (Array.isArray(summary.findings)) {
    findings.push(...summary.findings.slice(0, 100));
  }
  const texts = findings
    .slice(0, 100)
    .map((finding) => {
      const f = object(finding);
      return [f.file, f.line, f.category, f.description, f.suggestedFix]
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .join(': ')
        .slice(0, 4_000);
    })
    .filter(Boolean);
  if (typeof summary.humanNote === 'string') {
    texts.push(summary.humanNote.slice(0, 4_000));
  }
  return {
    approved: summary.approved,
    headSha: code.headSha,
    origin:
      run.reviewOfRun.template.origin === AGENT_RUN_TEMPLATE_ORIGIN &&
      run.reviewOfRun.template.teamId === null
        ? ('agent_run' as const)
        : ('workflow' as const),
    sourceRunId: payload.data.sourceRunId,
    sourceWorkflowId: run.reviewOfRun.workflowId,
    status: run.status,
    texts: [...new Set(texts)],
  };
}
