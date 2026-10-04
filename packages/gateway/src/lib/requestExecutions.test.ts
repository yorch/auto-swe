import { describe, expect, it } from 'vitest';
import { groupRequestExecutions } from './requestExecutions.js';

type Execution = Parameters<typeof groupRequestExecutions>[0][number];
function execution(id: string, status: Execution['status'], crossRepo = false): Execution {
  return {
    _count: { humanSteps: 0 },
    id,
    status,
    workflowId: id,
    workRequest: { activeWorkflows: [], isCrossRepo: crossRepo },
    workRequestId: 'request',
  };
}

describe('request execution grouping', () => {
  it('uses only the newest execution for an ordinary request even if the connection changed', () => {
    const groups = groupRequestExecutions([
      execution('new', 'SUCCESS'),
      execution('old', 'FAILED'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'new', status: 'SUCCESS', visibleExecutionCount: 1 });
  });

  it('keeps multi-repository work active when the newest child finished but another is running', () => {
    const groups = groupRequestExecutions([
      execution('finished', 'SUCCESS', true),
      execution('active', 'RUNNING', true),
    ]);
    expect(groups[0]).toMatchObject({
      id: 'active',
      isCrossRepo: true,
      status: 'RUNNING',
      visibleExecutionCount: 2,
    });
  });

  it('does not call a multi-repository request successful while a visible child failed', () => {
    const groups = groupRequestExecutions([
      execution('finished', 'SUCCESS', true),
      execution('failed', 'FAILED', true),
    ]);
    expect(groups[0]).toMatchObject({ id: 'failed', status: 'FAILED' });
  });

  it('retains child failures while other repositories are still running', () => {
    const groups = groupRequestExecutions([
      execution('active', 'RUNNING', true),
      execution('failed', 'FAILED', true),
    ]);
    expect(groups[0]).toMatchObject({ failedExecutionCount: 1, status: 'RUNNING' });
  });

  it('recognizes human-merge waiting only on the execution that owns the ledger row', () => {
    const run = execution('current', 'RUNNING');
    if (run.workRequest) {
      run.workRequest.activeWorkflows = [
        { currentStatus: 'AWAITING_HUMAN_MERGE', temporalWorkflowId: 'old' },
      ];
    }
    expect(groupRequestExecutions([run])[0].needsMerge).toBe(false);
    if (run.workRequest) {
      run.workRequest.activeWorkflows.push({
        currentStatus: 'AWAITING_HUMAN_MERGE',
        temporalWorkflowId: 'current',
      });
    }
    expect(groupRequestExecutions([run])[0].needsMerge).toBe(true);
  });
});
