import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { classifyAgentRunFailure } from '@/lib/agentRun';
import { findFailedStep } from '@/lib/runFailure';
import { safeHttpUrl } from '@/lib/safeUrl';
import { formatCost, isRecord } from '@/lib/utils';

export type RunVerdictTone = 'info' | 'success' | 'warning' | 'error';

/** The one thing the verdict points at; the page already holds the control it names. */
export type RunVerdictAction =
  | { kind: 'link'; label: string; href: string; external: boolean }
  | { kind: 'jump-to-failure'; label: string };

export interface RunVerdict {
  tone: RunVerdictTone;
  headline: string;
  detail: string;
  nextAction?: RunVerdictAction;
}

/** The slice of a human step the verdict reads. */
export interface PendingHumanStep {
  title: string;
  /** Only an APPROVAL gate counts approvals; the other kinds take one answer. */
  kind?: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  approvalsRemaining?: number;
  currentApprovers?: number;
  requiredApprovers?: number;
}

export type VerdictRun = Pick<
  WorkflowRunDetail,
  'status' | 'result' | 'steps' | 'costUsdAccrued' | 'isAgentRun'
>;

/** The anchor `RunSummary` puts on its "Needs a response" section. */
export const NEEDS_RESPONSE_ANCHOR = 'run-needs-response';

const NO_AUTO_MERGE = 'No built-in step merges it.';

function costSentence(cost: number, running = false): string {
  return cost > 0 ? ` It cost ${formatCost(cost)}${running ? ' so far' : ''}.` : '';
}

/** Sentence about a counted approval, only where the count says something a reader needs. */
function approvalsSentence(step: PendingHumanStep | undefined): string {
  const remaining = step?.approvalsRemaining;
  const multi = (step?.requiredApprovers ?? 1) > 1 || (step?.currentApprovers ?? 0) > 0;
  if (step?.kind !== 'APPROVAL' || !multi || typeof remaining !== 'number' || remaining <= 0) {
    return '';
  }
  return ` It still needs ${remaining} more approval${remaining === 1 ? '' : 's'}.`;
}

/** The latest attempt of each node whose step record is SKIPPED (a wait that ran out records so). */
function skippedNodeIds(steps: readonly WorkflowStepRecord[]): string[] {
  const latest = new Map<string, WorkflowStepRecord>();
  for (const step of steps) {
    const prev = latest.get(step.nodeId);
    if (!prev || step.attempt >= prev.attempt) {
      latest.set(step.nodeId, step);
    }
  }
  return [...latest.values()]
    .filter((st) => st.status === 'SKIPPED' && !st.error)
    .map((st) => st.nodeId);
}

function recordedPrUrl(result: unknown): string | null {
  const raw = isRecord(result) ? result.prUrl : undefined;
  return typeof raw === 'string' ? safeHttpUrl(raw) : null;
}

function pendingVerdict(steps: readonly PendingHumanStep[], cost: number): RunVerdict {
  const first = steps[0];
  const more =
    steps.length > 1 ? ` and ${steps.length - 1} more gate${steps.length > 2 ? 's' : ''}` : '';
  const needs = approvalsSentence(first);
  return {
    detail: `The run is paused at "${first?.title}"${more} until a person responds.${needs}${costSentence(cost, true)}`,
    headline: 'Waiting on a person',
    nextAction: {
      external: false,
      href: `#${NEEDS_RESPONSE_ANCHOR}`,
      kind: 'link',
      label: 'Go to the gate',
    },
    tone: 'warning',
  };
}

function failedVerdict(run: VerdictRun, failed: WorkflowStepRecord | null): RunVerdict {
  const timedOut = run.status === 'TIMED_OUT';
  const cost = costSentence(run.costUsdAccrued);
  const jump: RunVerdictAction = { kind: 'jump-to-failure', label: 'Jump to the failed step' };
  const view = classifyAgentRunFailure(failed?.error);
  // A budget stop reads the same for every template. Its sentence is neutral because the same
  // error code comes from a run's token-tier cap, an organization's monthly spending cap and a
  // runless budget, and the verdict cannot tell which from the code alone.
  if (view?.code === 'BUDGET_EXCEEDED') {
    return {
      detail: `The run hit a budget limit and stopped: its own token budget or an organization spending cap. The failed-step card shows the recorded message.${cost}`,
      headline: view.title,
      nextAction: failed ? jump : undefined,
      tone: 'error',
    };
  }
  // The other classified failures are agent-run refusals; a workflow's own step error is not
  // explained as one.
  if (view && run.isAgentRun === true) {
    return {
      detail: `${view.explanation}${cost}`,
      headline: view.title,
      nextAction: failed ? jump : undefined,
      tone: 'error',
    };
  }
  const outcome = timedOut ? 'The run timed out' : 'The run failed';
  if (failed) {
    return {
      detail: `${outcome}. The latest step recorded as failed is "${failed.nodeId}". The dashboard does not recognise this error, so no cause is stated here; the failed-step card shows what was recorded.${cost}`,
      headline: timedOut ? 'Timed out' : 'Failed',
      nextAction: jump,
      tone: 'error',
    };
  }
  if (timedOut) {
    // A wait that ran out (a gate or a signal) records its step as SKIPPED and routes to the
    // node's onTimeout edge, so the run's TIMED_OUT comes from a terminate node, not a failed step.
    const skipped = skippedNodeIds(run.steps);
    const prUrl = recordedPrUrl(run.result);
    const waits = skipped.length
      ? ` Steps recorded as skipped, which is how a wait that ran out is recorded: ${skipped
          .slice(0, 3)
          .map((id) => `"${id}"`)
          .join(', ')}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''}.`
      : '';
    return {
      detail: `The run ended as timed out and no failed step was recorded.${waits}${
        prUrl
          ? ' It also recorded a pull request; open it to see its current state.'
          : ' It recorded no pull request link, but one may still exist on the repository.'
      } The trace shows what it was doing.${cost}`,
      headline: 'Timed out',
      nextAction: prUrl
        ? { external: true, href: prUrl, kind: 'link', label: 'Open the pull request' }
        : undefined,
      tone: 'error',
    };
  }
  return {
    detail: `${outcome}, but no failed step was recorded, so no cause is stated here. The trace may show more.${cost}`,
    headline: 'Failed',
    tone: 'error',
  };
}

function successVerdict(run: VerdictRun): RunVerdict {
  const cost = costSentence(run.costUsdAccrued);
  const raw = isRecord(run.result) ? run.result.prUrl : undefined;
  const prUrl = recordedPrUrl(run.result);
  if (prUrl) {
    return {
      detail: `The run finished and recorded a pull request. Open it to see its current state. ${NO_AUTO_MERGE}${cost}`,
      headline: 'Finished with a pull request',
      nextAction: { external: true, href: prUrl, kind: 'link', label: 'Open the pull request' },
      tone: 'success',
    };
  }
  const unlinked =
    typeof raw === 'string' && raw !== ''
      ? ' A pull request address was recorded, but it is not a web link, so it is not linked here.'
      : ' It recorded no pull request link.';
  return {
    detail: `The run finished.${unlinked} Finished means the workflow reached its end, not that the output is correct: review it before relying on it.${cost}`,
    headline: 'Finished',
    tone: 'success',
  };
}

/**
 * The run page's verdict in plain language, from what the run record says and nothing more.
 * It names a cause only when the recorded error is one the dashboard classifies; otherwise it
 * says so and points at the failed step. `pendingHumanSteps` are the open gates of this run.
 */
export function deriveRunVerdict(
  run: VerdictRun,
  pendingHumanSteps: readonly PendingHumanStep[] = []
): RunVerdict {
  switch (run.status) {
    case 'RUNNING':
      if (pendingHumanSteps.length > 0) {
        return pendingVerdict(pendingHumanSteps, run.costUsdAccrued);
      }
      return {
        detail: `The run has not ended and no open gate is listed for it.${costSentence(run.costUsdAccrued, true)}`,
        headline: 'Running',
        tone: 'info',
      };
    case 'SUCCESS':
      return successVerdict(run);
    case 'FAILED':
    case 'TIMED_OUT':
      return failedVerdict(run, findFailedStep(run.status, run.steps));
    case 'CANCELLED':
      return {
        detail: `The run was stopped before it finished, so its output may be incomplete.${costSentence(run.costUsdAccrued)}`,
        headline: 'Cancelled',
        tone: 'info',
      };
    case 'SKIPPED':
      return {
        detail: `The workflow ended at a step its author marks as skipped. That does not mean nothing ran: steps before it may have run and cost money.${costSentence(run.costUsdAccrued)}`,
        headline: 'Skipped',
        tone: 'info',
      };
    default:
      return {
        detail: 'The run record carries a status this page does not recognise.',
        headline: 'Unknown status',
        tone: 'info',
      };
  }
}
