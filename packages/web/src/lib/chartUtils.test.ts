import type { WorkflowSummary } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import {
  groupLessonsByDate,
  groupLessonsByType,
  groupWorkflowsByDate,
  groupWorkflowsByStatus,
} from './chartUtils.js';

function makeWorkflow(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    assignedBranch: 'auto/TEST-1',
    budgetTier: 'STANDARD' as WorkflowSummary['budgetTier'],
    costUsdAccrued: 0,
    currentStatus: 'COMPLETED',
    id: 'wf-1',
    pullRequests: [],
    repository: null,
    temporalWorkflowId: 'eng-team-repo-TEST-1',
    tokensInputUsed: 0,
    tokensOutputUsed: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

describe('groupWorkflowsByStatus', () => {
  it('returns an empty array for no workflows', () => {
    expect(groupWorkflowsByStatus([])).toEqual([]);
  });

  it('counts workflows per status', () => {
    const result = groupWorkflowsByStatus([
      makeWorkflow({ currentStatus: 'COMPLETED' }),
      makeWorkflow({ currentStatus: 'COMPLETED' }),
      makeWorkflow({ currentStatus: 'FAILED' }),
    ]);
    const byStatus = new Map(result.map((r) => [r.status, r.count]));
    expect(byStatus.get('COMPLETED')).toBe(2);
    expect(byStatus.get('FAILED')).toBe(1);
  });

  it('falls back to UNKNOWN for a null/undefined status', () => {
    const result = groupWorkflowsByStatus([
      // biome-ignore lint/suspicious/noExplicitAny: exercising the nullish fallback branch
      makeWorkflow({ currentStatus: null as any }),
    ]);
    expect(result).toEqual([{ count: 1, status: 'UNKNOWN' }]);
  });
});

describe('groupWorkflowsByDate', () => {
  it('returns a 30-day bucket list with zero counts for no workflows', () => {
    const result = groupWorkflowsByDate([]);
    expect(result).toHaveLength(30);
    for (const bucket of result) {
      expect(bucket).toEqual({ active: 0, completed: 0, date: bucket.date, failed: 0 });
    }
  });

  it('respects a custom `days` window', () => {
    expect(groupWorkflowsByDate([], 7)).toHaveLength(7);
    expect(groupWorkflowsByDate([], 1)).toHaveLength(1);
  });

  it('buckets a COMPLETED workflow into `completed` on its updatedAt day', () => {
    const result = groupWorkflowsByDate([
      makeWorkflow({ currentStatus: 'COMPLETED', updatedAt: daysAgoIso(0) }),
    ]);
    const today = result.at(-1);
    expect(today?.completed).toBe(1);
    expect(today?.failed).toBe(0);
    expect(today?.active).toBe(0);
  });

  it('buckets FAILED and TIMED_OUT workflows into `failed`', () => {
    const result = groupWorkflowsByDate([
      makeWorkflow({ currentStatus: 'FAILED', updatedAt: daysAgoIso(0) }),
      makeWorkflow({ currentStatus: 'TIMED_OUT', updatedAt: daysAgoIso(0) }),
    ]);
    const today = result.at(-1);
    expect(today?.failed).toBe(2);
  });

  it('buckets every other status into `active`', () => {
    const result = groupWorkflowsByDate([
      makeWorkflow({ currentStatus: 'IMPLEMENTING', updatedAt: daysAgoIso(0) }),
      makeWorkflow({ currentStatus: 'IN_REVIEW', updatedAt: daysAgoIso(0) }),
    ]);
    const today = result.at(-1);
    expect(today?.active).toBe(2);
  });

  it('silently drops workflows whose updatedAt falls outside the bucket window', () => {
    const result = groupWorkflowsByDate([makeWorkflow({ updatedAt: daysAgoIso(365) })], 7);
    const totalCount = result.reduce((sum, b) => sum + b.completed + b.failed + b.active, 0);
    expect(totalCount).toBe(0);
  });

  it('orders buckets oldest to newest, ending on today', () => {
    const result = groupWorkflowsByDate([], 3);
    const todayKey = new Date().toISOString().slice(0, 10);
    expect(result.at(-1)?.date).toBe(todayKey);
    const [first, second] = result;
    expect(first?.date).toBeDefined();
    expect(second?.date).toBeDefined();
    expect((first?.date ?? '') < (second?.date ?? '')).toBe(true);
  });
});

describe('groupLessonsByType', () => {
  it('returns an empty array for no lessons', () => {
    expect(groupLessonsByType([])).toEqual([]);
  });

  it('replaces underscores with spaces in the failure type', () => {
    const result = groupLessonsByType([
      { createdAt: new Date().toISOString(), failureType: 'TEST_FAILURE' },
    ]);
    expect(result).toEqual([{ count: 1, type: 'TEST FAILURE' }]);
  });

  it('falls back to "Unknown" for a null failureType', () => {
    const result = groupLessonsByType([{ createdAt: new Date().toISOString(), failureType: null }]);
    expect(result).toEqual([{ count: 1, type: 'Unknown' }]);
  });

  it('sorts by count descending', () => {
    const result = groupLessonsByType([
      { createdAt: new Date().toISOString(), failureType: 'A' },
      { createdAt: new Date().toISOString(), failureType: 'B' },
      { createdAt: new Date().toISOString(), failureType: 'B' },
    ]);
    expect(result).toEqual([
      { count: 2, type: 'B' },
      { count: 1, type: 'A' },
    ]);
  });
});

describe('groupLessonsByDate', () => {
  it('returns a 30-day bucket list with zero counts for no lessons', () => {
    const result = groupLessonsByDate([]);
    expect(result).toHaveLength(30);
    expect(result.every((b) => b.count === 0)).toBe(true);
  });

  it('respects a custom `days` window', () => {
    expect(groupLessonsByDate([], 5)).toHaveLength(5);
  });

  it('counts lessons on their createdAt day', () => {
    const result = groupLessonsByDate([
      { createdAt: daysAgoIso(0), failureType: 'x' },
      { createdAt: daysAgoIso(0), failureType: 'y' },
    ]);
    expect(result.at(-1)?.count).toBe(2);
  });

  it('drops lessons outside the bucket window', () => {
    const result = groupLessonsByDate([{ createdAt: daysAgoIso(365), failureType: 'x' }], 7);
    expect(result.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });
});
