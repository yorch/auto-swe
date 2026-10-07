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
 * evidence the workflow hands the lesson writer is the latest. What does
 * survive every visit is the run's `AgentTrace` rows:
 *
 *  - each review network dispatch writes one `llm_response` row per reviewer:
 *    its verdict with the findings, or the error a crashed reviewer threw;
 *  - each CI fix session writes a {@link CI_FAILURE_TRACE_EVENT} event holding
 *    the end of the logs it was asked to fix.
 *
 * One entry is one review dispatch that rejected, or one CI failure. A
 * consensus review dispatches once per reviewer branch, so one consensus round
 * can be two rejections. Reading the rows in the lesson activity needs no
 * workflow change. Every text is bounded, per entry and per kind, because it
 * goes into a prompt.
 */

/** Most characters kept of one entry's text: the head of a rejection, the tail of a CI log. */
export const ENTRY_TEXT_LIMIT = 1_500;
/** Most entries kept of each kind; the latest ones win. */
export const ENTRIES_KEPT = 5;
/**
 * Characters shared by the kept entries of one kind: each gets an equal share,
 * up to {@link ENTRY_TEXT_LIMIT}, so every kept entry is seen.
 */
export const KIND_TEXT_LIMIT = 4_000;
/** Trace rows read of each kind. A review dispatch writes three. */
export const ROW_LIMIT = 60;

export interface HistoryEntry {
  /** 1-based position among the entries of its kind that were read. */
  n: number;
  text: string;
}

export interface LessonAttemptHistory {
  reviewRejections: HistoryEntry[];
  ciFailures: HistoryEntry[];
  /** Earlier entries of each kind left out by {@link ENTRIES_KEPT}. */
  omitted: { reviewRejections: number; ciFailures: number };
}

export interface AttemptTraceRow {
  /** The interpreter's recording id: a loop node revisited keeps the same one. */
  recordingId: string | null;
  /** Temporal's attempt at one scheduled activity; above 1 is a retry. */
  attempt: number;
  temporalRunId: string | null;
  createdAt: Date;
  /** The reviewer, on a review row. */
  toolName: string | null;
  /** Carries `activityId` when the row was written inside an activity. */
  outputJson: unknown;
  error: string | null;
}

/**
 * Read the run's history. Every query is scoped to the one run by `runId`.
 * Throws on a database error; the caller treats that as no history.
 */
export async function readLessonAttemptHistory(runId: string): Promise<LessonAttemptHistory> {
  const select = {
    attempt: true,
    createdAt: true,
    error: true,
    outputJson: true,
    recordingId: true,
    temporalRunId: true,
    toolName: true,
  } as const;
  // Newest first so the row bound keeps the latest entries; put back in order below.
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
  return buildAttemptHistory(reviewRows.reverse(), ciRows.reverse(), {
    // A full page may have cut the oldest dispatch short; it is dropped, not misread.
    reviewRowsCut: reviewRows.length >= ROW_LIMIT,
  });
}

/** Build the history from trace rows in the order they were written. Pure. */
export function buildAttemptHistory(
  reviewRows: readonly AttemptTraceRow[],
  ciRows: readonly AttemptTraceRow[],
  opts: { reviewRowsCut?: boolean } = {}
): LessonAttemptHistory {
  const dispatches = scheduledActivities(reviewRows);
  const rejections = (opts.reviewRowsCut ? dispatches.slice(1) : dispatches)
    .map((rows) => rejectionOf(rows))
    .filter((t): t is string => t !== undefined);
  const failures = withoutRepeats(
    scheduledActivities(ciRows)
      .map((rows) => logTailOf(rows[rows.length - 1]?.outputJson))
      .filter((t): t is string => t !== undefined)
  );
  const review = bound(rejections, head);
  const ci = bound(failures, tail);
  return {
    ciFailures: ci.kept,
    omitted: { ciFailures: ci.omitted, reviewRejections: review.omitted },
    reviewRejections: review.kept,
  };
}

/** Does the history hold more than the latest entry, which the context evidence already has? */
export function hasMoreThanLatest(history: LessonAttemptHistory): boolean {
  return (
    history.reviewRejections.length + history.omitted.reviewRejections > 1 ||
    history.ciFailures.length + history.omitted.ciFailures > 1
  );
}

/**
 * The rows of each scheduled activity, oldest first, keeping only its last
 * Temporal attempt.
 *
 * A row that carries `outputJson.activityId` is grouped by it: the id is the
 * same on every retry of one scheduled activity and new on the next one, so a
 * retry never stands in for a different fix or review, even when an earlier
 * attempt wrote no rows at all. A row without it is grouped by its persisted
 * batch (one activity attempt's rows share the recording id, the attempt and
 * the insert's timestamp) and never collapsed: a retry may then count twice,
 * which loses nothing.
 */
function scheduledActivities(rows: readonly AttemptTraceRow[]): AttemptTraceRow[][] {
  const groups = new Map<string, { first: number; attempt: number; rows: AttemptTraceRow[] }>();
  rows.forEach((row, i) => {
    const activityId = (row.outputJson as { activityId?: unknown } | null)?.activityId;
    const key =
      typeof activityId === 'string'
        ? `activity|${row.temporalRunId ?? ''}|${activityId}`
        : `batch|${row.recordingId ?? ''}|${row.attempt}|${row.createdAt.getTime()}`;
    const group = groups.get(key);
    if (!group || row.attempt > group.attempt) {
      // A later attempt replaces what the earlier ones wrote, and takes their place in order.
      groups.set(key, { attempt: row.attempt, first: i, rows: [row] });
    } else if (row.attempt === group.attempt) {
      group.rows.push(row);
    }
  });
  return [...groups.values()].sort((a, b) => a.first - b.first).map((g) => g.rows);
}

/** Drop an entry that repeats the one before it: a fix that changed nothing meets the same log. */
function withoutRepeats(texts: readonly string[]): string[] {
  return texts.filter((text, i) => i === 0 || text !== texts[i - 1]);
}

/** A dispatch's rejection, worded as the fixer was given it; undefined when it approved. */
function rejectionOf(rows: readonly AttemptTraceRow[]): string | undefined {
  const verdicts = rows.map(verdictOf).filter((v): v is ReviewVerdict => v !== undefined);
  if (verdicts.length === 0 || verdicts.every((v) => v.approved)) {
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
  return {
    approved: value.approved,
    findings: value.findings,
    reviewer: value.reviewer ?? reviewer,
    severity: value.severity ?? 'WARNING',
  };
}

function logTailOf(value: unknown): string | undefined {
  const logTail = (value as { logTail?: unknown } | null)?.logTail;
  return typeof logTail === 'string' && logTail.trim() !== '' ? logTail : undefined;
}

/** Number the texts, keep the latest {@link ENTRIES_KEPT}, and give each an equal share. */
function bound(
  texts: readonly string[],
  cap: (text: string, limit: number) => string
): { kept: HistoryEntry[]; omitted: number } {
  const latest = texts.map((text, i) => ({ n: i + 1, text })).slice(-ENTRIES_KEPT);
  const share = Math.min(
    ENTRY_TEXT_LIMIT,
    Math.floor(KIND_TEXT_LIMIT / Math.max(1, latest.length))
  );
  return {
    kept: latest.map((e) => ({ n: e.n, text: cap(e.text, share) })),
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
