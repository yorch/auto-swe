import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WORKFLOW_TERMINAL_STATUSES,
  isTerminalActiveWorkflowStatus,
  isTerminalWorkflowRunStatus,
  WORKFLOW_RUN_FAILURE_STATUSES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_TERMINAL_STATUSES,
} from '../types/api.js';
import { computeAnalytics, computeGlobalAnalytics } from './analytics.js';

const at = new Date('2026-01-01T00:00:00Z');
const end = new Date('2026-01-01T00:10:00Z');

describe('canonical terminal-status sets', () => {
  it('treats every run status but RUNNING as terminal, SKIPPED included', () => {
    expect([...WORKFLOW_RUN_TERMINAL_STATUSES].sort()).toEqual(
      WORKFLOW_RUN_STATUSES.filter((s) => s !== 'RUNNING').sort()
    );
    expect(isTerminalWorkflowRunStatus('SKIPPED')).toBe(true);
    expect(isTerminalWorkflowRunStatus('RUNNING')).toBe(false);
  });

  it('does not count SKIPPED as a failure', () => {
    expect(WORKFLOW_RUN_FAILURE_STATUSES.has('SKIPPED')).toBe(false);
    for (const s of WORKFLOW_RUN_FAILURE_STATUSES) {
      expect(WORKFLOW_RUN_TERMINAL_STATUSES.has(s)).toBe(true);
    }
  });

  it('uses the ledger vocabulary for ActiveWorkflow', () => {
    expect([...ACTIVE_WORKFLOW_TERMINAL_STATUSES].sort()).toEqual([
      'CANCELLED',
      'COMPLETED',
      'FAILED',
      'TIMED_OUT',
    ]);
    expect(isTerminalActiveWorkflowStatus('IMPLEMENTING')).toBe(false);
  });
});

describe('analytics agree on SKIPPED', () => {
  const statuses = ['SUCCESS', 'FAILED', 'SKIPPED', 'RUNNING'];

  it('per-template: SKIPPED is finished but outside the success-rate denominator', () => {
    const result = computeAnalytics(
      statuses.map((status) => ({
        endedAt: status === 'RUNNING' ? null : end,
        startedAt: at,
        status,
        templateVersion: 1,
      })),
      [],
      30
    );
    expect(result.successRate).toBe(0.5);
  });

  it('global: SKIPPED is completed, not running forever, and rates match per-template', () => {
    const result = computeGlobalAnalytics(
      statuses.map((status) => ({
        costUsdAccrued: 0,
        endedAt: status === 'RUNNING' ? null : end,
        startedAt: at,
        status,
        templateId: 't1',
        templateName: 'T',
      })),
      30
    );
    expect(result.runningRuns).toBe(1);
    expect(result.completedRuns).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.successRate).toBe(0.5);
    expect(result.perTemplate[0]?.successRate).toBe(0.5);
  });
});
