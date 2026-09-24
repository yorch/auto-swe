import { describe, expect, it } from 'vitest';
import { epicChildRunCell } from './epicChildRun';

const runs = new Map([['wf-a', 'run-a']]);

describe('epicChildRunCell', () => {
  it('links a visible run', () => {
    expect(
      epicChildRunCell({ status: 'IMPLEMENTING', temporalWorkflowId: 'wf-a' }, runs, true)
    ).toEqual({ kind: 'run', runId: 'run-a' });
  });

  it('reports a child with no workflow as not started', () => {
    expect(epicChildRunCell({ status: 'PENDING', temporalWorkflowId: null }, runs, true).kind).toBe(
      'not-started'
    );
  });

  it('says starting while the run list loads or the child is still registering', () => {
    expect(
      epicChildRunCell({ status: 'IMPLEMENTING', temporalWorkflowId: 'wf-b' }, runs, false).kind
    ).toBe('starting');
    expect(
      epicChildRunCell({ status: 'STARTING', temporalWorkflowId: 'wf-b' }, runs, true).kind
    ).toBe('starting');
  });

  it('reports no access for a started child whose run is not visible', () => {
    expect(
      epicChildRunCell({ status: 'IMPLEMENTING', temporalWorkflowId: 'wf-b' }, runs, true).kind
    ).toBe('no-access');
    expect(
      epicChildRunCell({ status: 'COMPLETED', temporalWorkflowId: 'wf-b' }, runs, true).kind
    ).toBe('no-access');
  });
});
