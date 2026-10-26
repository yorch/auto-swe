/**
 * The `awaitQodoReview` step: wait for, then read, Qodo's review of the pull request the run just
 * opened, so a template can route on its severity.
 *
 * Qodo cannot be asked over MCP to start a review; this step only waits for the review Qodo's own
 * pull-request bot produces, so it reports something useful only where that bot is installed.
 *
 * It never throws and never fails the run. Every outcome is a typed {@link QodoReviewResult}, and
 * the result has no `passed` field, so the interpreter never reads it as a failed quality gate: a
 * template blocks on Qodo only by routing on `status` / `blocking` itself.
 *
 * The Qodo connection is the one the run's REPOSITORY'S team owns (`createQodoFindingsClient`
 * resolves it and applies the connection access check). Nothing in the node, its inputs or the
 * template names a connection or a team, so a template can never spend another team's credential.
 * Findings are untrusted third-party text, bounded by the client; a template must not feed them
 * unfenced into an agent prompt.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { withHeartbeat } from '../lib/execUtils.js';
import {
  actionLevelAtLeast,
  createQodoFindingsClient,
  isOpenFinding,
  type QodoActionLevel,
  type QodoFindingsClient,
  type QodoPrReviewState,
} from '../lib/qodo/client.js';

/** The longest a node may wait; the step's start-to-close timeout is well above this. */
export const QODO_REVIEW_MAX_WAIT_SECONDS = 600;
/** How long to wait between reads of Qodo's review. */
export const QODO_REVIEW_POLL_INTERVAL_MS = 10_000;
/** Findings returned in the result; the rest are counted but not listed. */
export const QODO_REVIEW_MAX_FINDINGS = 25;

export type QodoReviewStatus = 'reviewed' | 'pending' | 'stale' | 'unavailable' | 'disabled';
export type QodoReviewSeverity = 'action_required' | 'remediation_recommended' | 'informational';

export interface QodoReviewFinding {
  id: string;
  title: string;
  description: string;
  category: string;
  actionLevel: QodoActionLevel;
  attributionStatus: string;
}

export interface QodoReviewResult {
  status: QodoReviewStatus;
  /** The commit Qodo's latest review covers, or null when it has no review. */
  reviewedHeadSha: string | null;
  headMatches: boolean;
  /** Open findings only, and only when `status` is `reviewed`. */
  counts: {
    actionRequired: number;
    remediationRecommended: number;
    informational: number;
    open: number;
  };
  worst: QodoReviewSeverity | 'none';
  /** At least one open finding at `action_required`, in a review of the head commit. */
  blocking: boolean;
  findings: QodoReviewFinding[];
  truncated: boolean;
  /**
   * Strings of Qodo's answer the injection screen replaced with a placeholder. A finding whose
   * title or description was withheld is still counted and still blocks; only its text is gone.
   */
  withheldFields: number;
}

export interface AwaitQodoReviewInput {
  /** The run's repository; its team decides whose Qodo connection is used. */
  repoId: string | null;
  prUrl?: unknown;
  headSha?: unknown;
  /** Node config. Absent: the `qodo.reviewWaitSeconds` setting. */
  waitSeconds?: unknown;
  /** Node config. Open findings below this level are ignored. Default: every level. */
  minActionLevel?: unknown;
}

const LEVELS: readonly QodoReviewSeverity[] = [
  'action_required',
  'remediation_recommended',
  'informational',
];

function emptyResult(over: Partial<QodoReviewResult>): QodoReviewResult {
  return {
    blocking: false,
    counts: { actionRequired: 0, informational: 0, open: 0, remediationRecommended: 0 },
    findings: [],
    headMatches: false,
    reviewedHeadSha: null,
    status: 'unavailable',
    truncated: false,
    withheldFields: 0,
    worst: 'none',
    ...over,
  };
}

/** Whole seconds in [0, {@link QODO_REVIEW_MAX_WAIT_SECONDS}]; a non-number is `fallback`. */
export function clampWaitSeconds(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(QODO_REVIEW_MAX_WAIT_SECONDS, Math.max(0, Math.floor(n)));
}

function reviewed(
  state: Extract<QodoPrReviewState, { kind: 'ok' }>,
  minLevel: QodoReviewSeverity | undefined
): QodoReviewResult {
  const open = state.findings
    .filter(isOpenFinding)
    .filter((f) => !minLevel || actionLevelAtLeast(f, minLevel));
  const count = (level: QodoReviewSeverity) => open.filter((f) => f.actionLevel === level).length;
  const counts = {
    actionRequired: count('action_required'),
    informational: count('informational'),
    open: open.length,
    remediationRecommended: count('remediation_recommended'),
  };
  const ranked = LEVELS.flatMap((level) => open.filter((f) => f.actionLevel === level));
  const listed = ranked.slice(0, QODO_REVIEW_MAX_FINDINGS);
  return {
    blocking: counts.actionRequired > 0,
    counts,
    findings: listed.map((f) => ({
      actionLevel: f.actionLevel,
      attributionStatus: f.attributionStatus,
      category: f.category,
      description: f.description,
      id: f.id,
      title: f.title,
    })),
    headMatches: true,
    reviewedHeadSha: state.session.commitSha,
    status: 'reviewed',
    truncated: state.truncated || ranked.length > listed.length,
    withheldFields: state.withheldFields,
    worst: LEVELS.find((level) => count(level) > 0) ?? 'none',
  };
}

export interface ReadQodoReviewArgs {
  client: QodoFindingsClient;
  prUrl: string;
  headSha: string;
  waitSeconds: number;
  minLevel?: QodoReviewSeverity;
  /** Receives a fixed-reason event when Qodo could not be read. */
  tracer?: Pick<AgentTracer, 'addActivityEvent'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll Qodo until its review of exactly `headSha` is complete or `waitSeconds` pass, and shape
 * what it said. Pure over the client, so it is tested with a scripted one.
 */
export async function readQodoReview(args: ReadQodoReviewArgs): Promise<QodoReviewResult> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + args.waitSeconds * 1_000;
  const want = args.headSha.toLowerCase();
  for (;;) {
    const state = await args.client.getPrReviewState(args.prUrl);
    let last: QodoReviewResult;
    if (state.kind === 'unavailable') {
      args.tracer?.addActivityEvent({
        name: 'qodo.read_unavailable',
        outputJson: { reason: state.reason },
      });
      return emptyResult({ status: state.reason === 'disabled' ? 'disabled' : 'unavailable' });
    }
    if (state.kind === 'no_session') {
      // Indistinguishable from a review Qodo has not started yet, so it waits like one.
      last = emptyResult({ status: 'pending' });
    } else {
      const matches = state.session.commitSha.toLowerCase() === want;
      const base = { headMatches: matches, reviewedHeadSha: state.session.commitSha };
      if (!matches) {
        last = emptyResult({ ...base, status: 'stale' });
      } else if (state.session.status === 'failed') {
        return emptyResult({ ...base, status: 'unavailable' });
      } else if (state.session.status === 'completed') {
        return reviewed(state, args.minLevel);
      } else {
        last = emptyResult({ ...base, status: 'pending' });
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return last;
    }
    await sleep(Math.min(QODO_REVIEW_POLL_INTERVAL_MS, remaining));
  }
}

/** Why an outcome is what it is: a fixed string, never text from Qodo or an error. */
type OutcomeReason =
  | 'no_repository'
  | 'repository_has_no_team'
  | 'disabled'
  | 'inputs_missing'
  | 'read'
  | 'error';

async function awaitQodoReviewImpl(
  input: AwaitQodoReviewInput,
  tracer: AgentTracer
): Promise<{ reason: OutcomeReason; result: QodoReviewResult }> {
  try {
    if (!input.repoId) {
      return { reason: 'no_repository', result: emptyResult({ status: 'unavailable' }) };
    }
    // The team comes from the run's repository, never from the node or its inputs.
    const repo = await prisma.connection.findUnique({
      select: { team: { select: { orgId: true } }, teamId: true },
      where: { id: input.repoId, type: 'git_repo' },
    });
    if (!repo?.teamId) {
      return { reason: 'repository_has_no_team', result: emptyResult({ status: 'unavailable' }) };
    }
    const ctx = { ...(repo.team?.orgId ? { orgId: repo.team.orgId } : {}), teamId: repo.teamId };
    // Off means no connection lookup and no network call at all.
    if (!(await resolveSetting('qodo.enabled', ctx))) {
      return { reason: 'disabled', result: emptyResult({ status: 'disabled' }) };
    }
    if (typeof input.prUrl !== 'string' || typeof input.headSha !== 'string' || !input.headSha) {
      return { reason: 'inputs_missing', result: emptyResult({ status: 'unavailable' }) };
    }
    const configured = await resolveSetting('qodo.reviewWaitSeconds', ctx);
    const minLevel = LEVELS.find((level) => level === input.minActionLevel);
    return {
      reason: 'read',
      result: await readQodoReview({
        client: createQodoFindingsClient({ ...ctx, tracer }),
        headSha: input.headSha,
        ...(minLevel ? { minLevel } : {}),
        prUrl: input.prUrl,
        tracer,
        waitSeconds: clampWaitSeconds(input.waitSeconds, configured),
      }),
    };
  } catch {
    // Nothing thrown here is worth surfacing: it could carry a URL or a response body.
    return { reason: 'error', result: emptyResult({ status: 'unavailable' }) };
  }
}

export async function awaitQodoReview(input: AwaitQodoReviewInput): Promise<QodoReviewResult> {
  const tracer = new AgentTracer();
  let outcome: { reason: OutcomeReason; result: QodoReviewResult } = {
    reason: 'error',
    result: emptyResult({ status: 'unavailable' }),
  };
  try {
    outcome = await withHeartbeat('awaitQodoReview', awaitQodoReviewImpl(input, tracer));
  } catch {
    // The step never fails the run; the outcome stays `unavailable` with reason `error`.
  } finally {
    tracer.addActivityEvent({
      name: 'qodo.review_outcome',
      outputJson: {
        reason: outcome.reason,
        status: outcome.result.status,
        withheldFields: outcome.result.withheldFields,
      },
    });
    try {
      await persistActivityTrace(tracer, 'qodoReview');
    } catch {
      // Observability is best-effort: a failed trace write must not change the step's outcome.
    }
  }
  return outcome.result;
}
