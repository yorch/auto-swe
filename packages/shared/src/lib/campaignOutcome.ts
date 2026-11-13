/**
 * Maps what a campaign child run returned to the row that records it.
 *
 * A child is `RunnableWorkflow`, which returns the terminate node's result with `status` spread
 * over it. The `dependency-upgrade-campaign` template reports `changed`, `path` and `verification`
 * beside the usual `prNumber`/`prUrl`; those arrive as `unknown` (a result is JSON that crossed a
 * workflow boundary) and are validated here rather than trusted.
 *
 * Pure: no I/O and no Prisma import, so the workflow-side code and the gateway share it. The
 * state names mirror the `CampaignTargetState`, `CampaignTargetPath`, `CampaignVerification` and
 * `CampaignState` Prisma enums; the string unions here are the same values.
 */
import type { WorkflowResult } from '../types/workflow.js';

export type CampaignTargetStateName =
  | 'PENDING'
  | 'RUNNING'
  | 'PR_OPENED'
  | 'NOT_AFFECTED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED';

export type CampaignTargetPathName = 'RECIPE' | 'AGENT' | 'RECIPE_THEN_AGENT' | 'NONE';

export type CampaignVerificationName = 'PASSED' | 'FAILED' | 'NOT_RUN';

export type CampaignStateName =
  | 'STARTING'
  | 'RUNNING'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_FAILURES'
  | 'CANCELLED'
  | 'FAILED_TO_START';

/** A target in one of these states is finished and is never written again. */
export const CAMPAIGN_TARGET_TERMINAL_STATES: readonly CampaignTargetStateName[] = [
  'PR_OPENED',
  'NOT_AFFECTED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
];

/** A campaign in one of these states is finished and never moves again. */
export const CAMPAIGN_TERMINAL_STATES: readonly CampaignStateName[] = [
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'CANCELLED',
  'FAILED_TO_START',
];

/**
 * Whether a UTF-16 code unit may not appear in a campaign's name or brief: a C0 control other than
 * tab, line feed and carriage return, DEL, or a C1 control. They have no place in a brief or a pull
 * request, and JSON writes a C0 control as a six-byte escape, which would let a short brief take
 * six times its length in every child's start event.
 */
function isForbiddenControl(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

/**
 * Why `text` cannot be a campaign's name or brief, or null when it can. Besides the control
 * characters above, a lone surrogate is refused: it is not text, and JSON escapes it in six bytes.
 */
export function campaignTextProblem(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isForbiddenControl(code)) {
      return 'must not contain control characters other than tab and line breaks';
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return 'must be well-formed Unicode text (no lone surrogates)';
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return 'must be well-formed Unicode text (no lone surrogates)';
    }
  }
  return null;
}

/** Longest failure reason stored on a target. */
export const CAMPAIGN_FAILURE_REASON_MAX = 500;

const PATHS: readonly CampaignTargetPathName[] = ['RECIPE', 'AGENT', 'RECIPE_THEN_AGENT', 'NONE'];
const VERIFICATIONS: readonly CampaignVerificationName[] = ['PASSED', 'FAILED', 'NOT_RUN'];

export interface CampaignTargetOutcome {
  state: CampaignTargetStateName;
  path: CampaignTargetPathName | null;
  verification: CampaignVerificationName | null;
  prUrl: string | null;
  prNumber: number | null;
  failureReason: string | null;
}

export interface CampaignOutcomeOptions {
  /** The campaign was cancelled: a child that did not finish its work is CANCELLED, not FAILED. */
  cancelled: boolean;
  /**
   * Redacts credential-shaped text. It runs BEFORE the length bound so a token cut in half by the
   * bound cannot slip past it. Injected because the masking lives in the worker; the workflow-side
   * caller passes `maskCredentialShapes`.
   */
  mask?: (text: string) => string;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Bound and clean free text for storage: control characters out, masked, then cut. */
export function boundFailureReason(
  text: string,
  mask: (text: string) => string = (s) => s
): string {
  const printable = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  }).join('');
  const cleaned = mask(printable).trim();
  return cleaned.length > CAMPAIGN_FAILURE_REASON_MAX
    ? `${cleaned.slice(0, CAMPAIGN_FAILURE_REASON_MAX - 1)}…`
    : cleaned;
}

function prNumberOf(result: Record<string, unknown>, prUrl: string | null): number | null {
  const n = result.prNumber;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) {
    return n;
  }
  const m = prUrl === null ? null : /\/pull\/(\d{1,9})(?:[/?#]|$)/.exec(prUrl);
  return m ? Number(m[1]) : null;
}

/**
 * The target row's outcome for one child result.
 *
 * | child result                          | state          |
 * |---------------------------------------|----------------|
 * | SUCCESS with a `prUrl`                | `PR_OPENED`    |
 * | SUCCESS with `changed === false`      | `NOT_AFFECTED` |
 * | SUCCESS with neither                  | `FAILED`       |
 * | FAILED, TIMED_OUT                     | `FAILED`       |
 * | SKIPPED                               | `SKIPPED`      |
 * | not finished, and the campaign was cancelled | `CANCELLED` |
 *
 * A child that finished its work before the cancel arrived keeps its outcome: an opened pull
 * request is not un-opened by a cancel, and the row must say so.
 */
export function campaignTargetOutcome(
  result: WorkflowResult | (Record<string, unknown> & { status?: unknown }),
  opts: CampaignOutcomeOptions
): CampaignTargetOutcome {
  const r = result as Record<string, unknown>;
  const reasonText = typeof r.skippedReason === 'string' ? r.skippedReason : '';
  const reason = (fallback: string): string =>
    boundFailureReason(reasonText.length > 0 ? reasonText : fallback, opts.mask);
  const path = oneOf(PATHS, r.path);
  const verification = oneOf(VERIFICATIONS, r.verification);
  const base = { path, prNumber: null, prUrl: null, verification } as const;

  if (r.status === 'SUCCESS') {
    const prUrl = typeof r.prUrl === 'string' && /^https?:\/\//.test(r.prUrl) ? r.prUrl : null;
    if (prUrl !== null) {
      return {
        ...base,
        failureReason: null,
        prNumber: prNumberOf(r, prUrl),
        prUrl,
        state: 'PR_OPENED',
      };
    }
    if (r.changed === false) {
      return { ...base, failureReason: null, state: 'NOT_AFFECTED' };
    }
    return {
      ...base,
      failureReason: boundFailureReason('the run finished without opening a pull request'),
      state: 'FAILED',
    };
  }
  if (opts.cancelled) {
    return { ...base, failureReason: null, state: 'CANCELLED' };
  }
  if (r.status === 'SKIPPED') {
    return { ...base, failureReason: reason('skipped'), state: 'SKIPPED' };
  }
  if (r.status === 'TIMED_OUT') {
    return { ...base, failureReason: reason('timed out'), state: 'FAILED' };
  }
  return { ...base, failureReason: reason('the run failed'), state: 'FAILED' };
}

/**
 * The campaign's final state once every target is settled. A cancel wins; otherwise any `FAILED`
 * or `SKIPPED` target makes it `COMPLETED_WITH_FAILURES`.
 */
export function campaignFinalState(
  targetStates: readonly CampaignTargetStateName[],
  cancelled: boolean
): Extract<CampaignStateName, 'COMPLETED' | 'COMPLETED_WITH_FAILURES' | 'CANCELLED'> {
  if (cancelled) {
    return 'CANCELLED';
  }
  return targetStates.some((s) => s === 'FAILED' || s === 'SKIPPED')
    ? 'COMPLETED_WITH_FAILURES'
    : 'COMPLETED';
}
