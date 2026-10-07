import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { ReviewVerdict } from '@auto-swe/shared/types/workflow';
import { summarizeRejections } from '../agents/reviewNetwork.js';
import { CI_FAILURE_TRACE_EVENT } from './attemptTrace.js';

/**
 * Every review rejection and CI failure a run recorded, rebuilt when its lesson
 * is written.
 *
 * The workflow keeps only a loop's latest rejection and CI logs in its context,
 * and a loop revisit overwrites the node's `WorkflowStep` row (unique on
 * `(runId, nodeId, attempt)`, where `attempt` counts retries only), so the
 * evidence the workflow hands the lesson writer is the last attempt's. What
 * does survive every attempt is the run's `AgentTrace` rows:
 *
 *  - each review network dispatch writes one `llm_response` row per reviewer:
 *    its verdict with the findings, or the error a crashed reviewer threw;
 *  - each CI fix session writes a {@link CI_FAILURE_TRACE_EVENT} event holding
 *    the end of the logs it was asked to fix.
 *
 * Reading them in the lesson activity needs no workflow change. Every text is
 * bounded, per attempt and per kind, because it goes into a prompt.
 */

/** Most characters kept of one attempt's text: the head of a rejection, the tail of a CI log. */
export const ATTEMPT_TEXT_LIMIT = 1_500;
/** Most attempts kept of each kind; the latest ones win. */
export const ATTEMPTS_KEPT = 5;
/**
 * Characters shared by the kept attempts of one kind: each gets an equal share,
 * up to {@link ATTEMPT_TEXT_LIMIT}, so every kept attempt is seen.
 */
export const ATTEMPT_KIND_TEXT_LIMIT = 4_000;
/** Trace rows read of each kind. A review dispatch writes three. */
const ROW_LIMIT = 60;

export interface AttemptEntry {
  /** 1-based position among the attempts of its kind that were read. */
  attempt: number;
  text: string;
}

export interface LessonAttemptHistory {
  reviewRejections: AttemptEntry[];
  ciFailures: AttemptEntry[];
  /** Earlier attempts of each kind left out by {@link ATTEMPTS_KEPT}. */
  omitted: { reviewRejections: number; ciFailures: number };
}

export interface AttemptTraceRow {
  /** The interpreter's recording id: a loop node revisited keeps the same one. */
  recordingId: string | null;
  /** Temporal's attempt at one dispatch; above 1 is a retry of the same dispatch. */
  attempt: number;
  createdAt: Date;
  /** The reviewer, on a review row. */
  toolName: string | null;
  outputJson: unknown;
  error: string | null;
}

/**
 * Read the run's attempt history. Every query is scoped to the one run by
 * `runId`. Throws on a database error; the caller treats that as no history.
 */
export async function readLessonAttemptHistory(runId: string): Promise<LessonAttemptHistory> {
  const select = {
    attempt: true,
    createdAt: true,
    error: true,
    outputJson: true,
    recordingId: true,
    toolName: true,
  } as const;
  // Newest first so the row bound keeps the latest attempts; put back in order below.
  const orderBy = [{ createdAt: 'desc' as const }, { seq: 'desc' as const }];
  const [reviewRows, ciRows] = await runUnscoped(
    'scoped to the one run the lesson is written about',
    ['AgentTrace'],
    () =>
      Promise.all([
        prisma.agentTrace.findMany({
          orderBy,
          select,
          take: ROW_LIMIT,
          where: { nodeId: 'runReviewNetwork', runId, type: 'llm_response' },
        }),
        prisma.agentTrace.findMany({
          orderBy,
          select,
          take: ROW_LIMIT,
          where: { runId, toolName: CI_FAILURE_TRACE_EVENT, type: 'activity_event' },
        }),
      ])
  );
  return buildAttemptHistory(reviewRows.reverse(), ciRows.reverse());
}

/** Build the history from trace rows in the order they were written. Pure. */
export function buildAttemptHistory(
  reviewRows: readonly AttemptTraceRow[],
  ciRows: readonly AttemptTraceRow[]
): LessonAttemptHistory {
  const rejections = collapseRetries(reviewDispatches(reviewRows))
    .map((d) => rejectionOf(d.verdicts))
    .filter((t): t is string => t !== undefined);
  const failures = collapseRetries(
    ciRows.map((row) => ({ ...row, text: logTailOf(row.outputJson) }))
  )
    .map((r) => r.text)
    .filter((t): t is string => t !== undefined);
  const review = bound(rejections, head);
  const ci = bound(failures, tail);
  return {
    ciFailures: ci.kept,
    omitted: { ciFailures: ci.omitted, reviewRejections: review.omitted },
    reviewRejections: review.kept,
  };
}

/** Does the history hold more than the latest attempt, which the context evidence already has? */
export function hasEarlierAttempts(history: LessonAttemptHistory): boolean {
  return (
    history.reviewRejections.length + history.omitted.reviewRejections > 1 ||
    history.ciFailures.length + history.omitted.ciFailures > 1
  );
}

interface Dispatch {
  recordingId: string | null;
  attempt: number;
  verdicts: ReviewVerdict[];
}

/**
 * One review dispatch per persisted batch: its reviewers' rows are written by
 * one insert, so they share the recording id, the Temporal attempt and the
 * insert's timestamp.
 */
function reviewDispatches(rows: readonly AttemptTraceRow[]): Dispatch[] {
  const byBatch = new Map<string, Dispatch>();
  for (const row of rows) {
    const verdict = verdictOf(row);
    if (!verdict) {
      continue;
    }
    const key = `${row.recordingId ?? ''}|${row.attempt}|${row.createdAt.getTime()}`;
    const dispatch = byBatch.get(key);
    if (dispatch) {
      dispatch.verdicts.push(verdict);
    } else {
      byBatch.set(key, { attempt: row.attempt, recordingId: row.recordingId, verdicts: [verdict] });
    }
  }
  return [...byBatch.values()];
}

/**
 * Keep only the last Temporal attempt of a retried dispatch. A dispatch's
 * attempts run one after another, and the next visit to the same node starts
 * again at attempt 1, so an item past attempt 1 replaces the latest one from
 * the same node.
 */
function collapseRetries<T extends { recordingId: string | null; attempt: number }>(
  items: readonly T[]
): T[] {
  const out: T[] = [];
  const latestByNode = new Map<string, number>();
  for (const item of items) {
    const node = item.recordingId ?? '';
    const previous = latestByNode.get(node);
    if (item.attempt > 1 && previous !== undefined) {
      out[previous] = item;
      continue;
    }
    latestByNode.set(node, out.length);
    out.push(item);
  }
  return out;
}

/** A dispatch's rejection, worded as the fixer was given it; undefined when it approved. */
function rejectionOf(verdicts: ReviewVerdict[]): string | undefined {
  if (verdicts.every((v) => v.approved)) {
    return undefined;
  }
  const text = summarizeRejections(verdicts);
  return text.trim() === '' ? undefined : text;
}

/**
 * The verdict a review row records. A reviewer that threw is a critical
 * rejection, as the review network counts it (`REVIEWER_CRASH`).
 */
function verdictOf(row: AttemptTraceRow): ReviewVerdict | undefined {
  const reviewer = (row.toolName ?? 'REVIEWER') as ReviewVerdict['reviewer'];
  if (row.error) {
    return {
      approved: false,
      findings: [
        {
          category: 'REVIEWER_CRASH',
          description: `Reviewer agent failed: ${row.error}`,
          file: '',
          suggestedFix: 'Manual review required',
        },
      ],
      reviewer,
      severity: 'CRITICAL',
    };
  }
  const value = row.outputJson as Partial<ReviewVerdict> | null;
  if (!value || typeof value.approved !== 'boolean' || !Array.isArray(value.findings)) {
    return undefined;
  }
  // Written by the review network from a validated verdict, so the shape holds.
  return { ...(value as ReviewVerdict), reviewer: value.reviewer ?? reviewer };
}

function logTailOf(value: unknown): string | undefined {
  const logTail = (value as { logTail?: unknown } | null)?.logTail;
  return typeof logTail === 'string' && logTail.trim() !== '' ? logTail : undefined;
}

/** Number the texts, keep the latest {@link ATTEMPTS_KEPT}, and give each an equal share. */
function bound(
  texts: readonly string[],
  cap: (text: string, limit: number) => string
): { kept: AttemptEntry[]; omitted: number } {
  const latest = texts.map((text, i) => ({ attempt: i + 1, text })).slice(-ATTEMPTS_KEPT);
  const share = Math.min(
    ATTEMPT_TEXT_LIMIT,
    Math.floor(ATTEMPT_KIND_TEXT_LIMIT / Math.max(1, latest.length))
  );
  return {
    kept: latest.map((e) => ({ attempt: e.attempt, text: cap(e.text, share) })),
    omitted: texts.length - latest.length,
  };
}

function head(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]`
    : text;
}

function tail(text: string, limit: number): string {
  return text.length > limit
    ? `[… ${text.length - limit} earlier characters]\n${text.slice(-limit)}`
    : text;
}
