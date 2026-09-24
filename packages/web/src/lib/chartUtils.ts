/**
 * Pure data transformation functions for dashboard charts.
 * These operate on the arrays already returned by useWorkflows() / useLessons().
 */

import type { WorkflowSummary } from '@auto-swe/shared/types/api';
import {
  isTerminalActiveWorkflowStatus,
  isTerminalWorkflowRunStatus,
} from '@auto-swe/shared/types/api';

type LessonForChart = { failureType: string | null; createdAt: string };

/**
 * `YYYY-MM-DD` for a timestamp, in UTC. Bucket keys and the window below both
 * use UTC so a run can never land on a key the window doesn't contain.
 */
function toDateKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10);
}

/**
 * The trailing `days`-day window, ending today, as UTC date keys.
 *
 * Computed per call rather than once at module load: a dashboard left open
 * across midnight kept bucketing into a stale window, and any run created
 * after the rollover fell outside every bucket and vanished from the chart.
 * Stepping by whole days in UTC also keeps the arithmetic and the keys on one
 * calendar — mixing local `setDate` with UTC `toISOString` shifted every
 * labelled bucket by a day for readers west of UTC.
 */
function lastDays(days: number): string[] {
  const out: string[] = [];
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

// ── Workflow status classes ───────────────────────────────────────────

/**
 * Buckets a workflow status for display. What counts as "over" is the shared
 * definition — `ActiveWorkflow` statuses (COMPLETED/FAILED/TIMED_OUT/CANCELLED)
 * and, for template-driven domain state that uses the run vocabulary,
 * `WorkflowRun` statuses (SUCCESS/SKIPPED/…). Anything not terminal in either —
 * including a status never heard of — is treated as still running. Terminal
 * statuses then split into success, a deliberate stop, or a failure.
 */
const SUCCEEDED_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'SUCCESS']);
const STOPPED_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'SKIPPED']);

export type WorkflowStatusClass = 'active' | 'completed' | 'failed' | 'stopped';

export function workflowStatusClass(status: string): WorkflowStatusClass {
  if (!(isTerminalActiveWorkflowStatus(status) || isTerminalWorkflowRunStatus(status))) {
    return 'active';
  }
  if (SUCCEEDED_WORKFLOW_STATUSES.has(status)) {
    return 'completed';
  }
  if (STOPPED_WORKFLOW_STATUSES.has(status)) {
    return 'stopped';
  }
  return 'failed';
}

// ── Workflow transformations ──────────────────────────────────────────

export function groupWorkflowsByStatus(
  workflows: WorkflowSummary[]
): { status: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const w of workflows) {
    const s = w.currentStatus ?? 'UNKNOWN';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ count, status }));
}

export function groupWorkflowsByDate(
  workflows: WorkflowSummary[],
  days = 30
): { date: string; completed: number; failed: number; active: number }[] {
  const buckets = lastDays(days);
  const map: Record<string, { completed: number; failed: number; active: number }> = {};
  for (const d of buckets) {
    map[d] = { active: 0, completed: 0, failed: 0 };
  }

  for (const w of workflows) {
    const key = toDateKey(w.updatedAt);
    if (!map[key]) {
      continue;
    }
    const cls = workflowStatusClass(w.currentStatus);
    // A cancelled or skipped workflow is neither a success, a failure, nor
    // still running — it is left out of all three series.
    if (cls !== 'stopped') {
      map[key][cls]++;
    }
  }
  return buckets.map((date) => ({ date, ...map[date] }));
}

// ── Lesson transformations ────────────────────────────────────────────

export function groupLessonsByType(lessons: LessonForChart[]): { type: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const l of lessons) {
    const t = l.failureType?.replace(/_/g, ' ') ?? 'Unknown';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ count, type }))
    .sort((a, b) => b.count - a.count);
}

export function groupLessonsByDate(
  lessons: LessonForChart[],
  days = 30
): { date: string; count: number }[] {
  const buckets = lastDays(days);
  const map: Record<string, number> = {};
  for (const d of buckets) {
    map[d] = 0;
  }

  for (const l of lessons) {
    const key = toDateKey(l.createdAt);
    if (map[key] !== undefined) {
      map[key]++;
    }
  }
  return buckets.map((date) => ({ count: map[date], date }));
}
