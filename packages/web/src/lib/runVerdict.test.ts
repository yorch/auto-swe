import type { WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { deriveRunVerdict, type VerdictRun } from './runVerdict';

function step(over: Partial<WorkflowStepRecord> = {}): WorkflowStepRecord {
  return {
    attempt: 1,
    endedAt: '2026-10-01T12:04:00Z',
    error: null,
    id: 's1',
    inputs: null,
    nodeId: 'build',
    outputs: null,
    startedAt: '2026-10-01T12:01:00Z',
    status: 'PASSED',
    ...over,
  };
}

function run(over: Partial<VerdictRun> = {}): VerdictRun {
  return { costUsdAccrued: 0, result: null, status: 'SUCCESS', steps: [], ...over };
}

describe('deriveRunVerdict', () => {
  it('running with no gate is info and claims nothing about people', () => {
    const v = deriveRunVerdict(run({ status: 'RUNNING' }));
    expect(v.tone).toBe('info');
    expect(v.headline).toBe('Running');
    expect(v.nextAction).toBeUndefined();
  });

  it('running at a gate says it waits on a person and links to the gate', () => {
    const v = deriveRunVerdict(run({ status: 'RUNNING' }), [
      {
        approvalsRemaining: 2,
        currentApprovers: 0,
        kind: 'APPROVAL',
        requiredApprovers: 2,
        title: 'Approve the plan',
      },
      { kind: 'DECISION', title: 'Second' },
    ]);
    expect(v.tone).toBe('warning');
    expect(v.headline).toBe('Waiting on a person');
    expect(v.detail).toContain('"Approve the plan" and 1 more gate');
    expect(v.detail).toContain('2 more approvals');
    expect(v.nextAction).toMatchObject({ href: '#run-needs-response', kind: 'link' });
  });

  it('does not say "needs 1 more approval" for an ordinary single-approver gate', () => {
    const v = deriveRunVerdict(run({ status: 'RUNNING' }), [
      {
        approvalsRemaining: 1,
        currentApprovers: 0,
        kind: 'APPROVAL',
        requiredApprovers: 1,
        title: 'Approve the plan',
      },
    ]);
    expect(v.detail).not.toContain('more approval');
  });

  it('says how many approvals are left once one has been given, and never for a non-approval gate', () => {
    const approval = deriveRunVerdict(run({ status: 'RUNNING' }), [
      {
        approvalsRemaining: 1,
        currentApprovers: 1,
        kind: 'APPROVAL',
        requiredApprovers: 2,
        title: 'Approve',
      },
    ]);
    expect(approval.detail).toContain('1 more approval.');
    const decision = deriveRunVerdict(run({ status: 'RUNNING' }), [
      {
        approvalsRemaining: 1,
        currentApprovers: 1,
        kind: 'DECISION',
        requiredApprovers: 2,
        title: 'Pick',
      },
    ]);
    expect(decision.detail).not.toContain('more approval');
  });

  it('only a running run says "so far" about cost', () => {
    expect(deriveRunVerdict(run({ costUsdAccrued: 2, status: 'RUNNING' })).detail).toContain(
      'so far'
    );
    expect(deriveRunVerdict(run({ costUsdAccrued: 2, status: 'CANCELLED' })).detail).not.toContain(
      'so far'
    );
    expect(deriveRunVerdict(run({ costUsdAccrued: 2, status: 'CANCELLED' })).detail).toContain(
      'It cost $2.00.'
    );
  });

  it('ignores open gates on a run that has ended', () => {
    const v = deriveRunVerdict(run({ status: 'CANCELLED' }), [{ title: 'Old gate' }]);
    expect(v.headline).toBe('Cancelled');
    expect(v.detail).not.toContain('Old gate');
  });

  it('success with a safe PR url points at it without claiming its state', () => {
    const v = deriveRunVerdict(run({ result: { prUrl: 'https://github.com/a/b/pull/1' } }));
    expect(v.tone).toBe('success');
    expect(v.headline).toBe('Finished with a pull request');
    expect(v.headline + v.detail).not.toMatch(/waiting|waits/i);
    expect(v.detail).toContain('its current state');
    expect(v.detail).toContain('No built-in step merges it');
    expect(v.nextAction).toMatchObject({ external: true, href: 'https://github.com/a/b/pull/1' });
  });

  it('success without a PR does not claim one and does not claim correctness', () => {
    const v = deriveRunVerdict(run({ result: { text: 'done' } }));
    expect(v.headline).toBe('Finished');
    expect(v.detail).toContain('recorded no pull request link');
    expect(v.detail).toContain('not that the output is correct');
    expect(v.nextAction).toBeUndefined();
  });

  it('success with an unsafe PR url links nothing', () => {
    const v = deriveRunVerdict(run({ result: { prUrl: 'javascript:alert(1)' } }));
    expect(v.nextAction).toBeUndefined();
    expect(v.detail).toContain('not a web link');
    expect(v.headline).not.toMatch(/pull request/i);
  });

  it('failed with an unclassified error says the cause is unknown and names the step', () => {
    const v = deriveRunVerdict(
      run({ status: 'FAILED', steps: [step({ error: 'socket hang up', status: 'FAILED' })] })
    );
    expect(v.tone).toBe('error');
    expect(v.detail).toContain('latest step recorded as failed is "build"');
    expect(v.detail).toContain('no cause is stated here');
    expect(v.nextAction?.kind).toBe('jump-to-failure');
  });

  it('failed with no failed step says none was recorded', () => {
    const v = deriveRunVerdict(run({ status: 'FAILED' }));
    expect(v.detail).toContain('no failed step was recorded');
    expect(v.nextAction).toBeUndefined();
  });

  it('a timed-out run with no failed step names the skipped waits and does not say "no failed step recorded" alone', () => {
    const v = deriveRunVerdict(
      run({
        result: {},
        status: 'TIMED_OUT',
        steps: [step({ nodeId: 'waitForHumanMerge', status: 'SKIPPED' })],
      })
    );
    expect(v.headline).toBe('Timed out');
    expect(v.detail).toContain('"waitForHumanMerge"');
    expect(v.detail).toContain('how a wait that ran out is recorded');
    expect(v.detail).toContain('one may still exist');
    expect(v.nextAction).toBeUndefined();
  });

  it('a timed-out run that recorded a pull request links it', () => {
    const v = deriveRunVerdict(
      run({ result: { prUrl: 'https://github.com/a/b/pull/9' }, status: 'TIMED_OUT' })
    );
    expect(v.nextAction).toMatchObject({ href: 'https://github.com/a/b/pull/9' });
    expect(v.detail).toContain('current state');
  });

  it('timed out is worded as a timeout', () => {
    const v = deriveRunVerdict(
      run({ status: 'TIMED_OUT', steps: [step({ error: 'x', status: 'FAILED' })] })
    );
    expect(v.headline).toBe('Timed out');
    expect(v.detail).toContain('The run timed out');
  });

  it('a budget stop is named for any template', () => {
    const v = deriveRunVerdict(
      run({
        costUsdAccrued: 1.5,
        status: 'FAILED',
        steps: [step({ error: 'BUDGET_EXCEEDED: cap hit', status: 'FAILED' })],
      })
    );
    expect(v.headline).toBe('Budget exhausted');
    expect(v.detail).toContain('budget limit');
    expect(v.detail).toContain('organization spending cap');
    expect(v.detail).not.toContain('larger budget tier');
    expect(v.detail).toContain('$1.50');
  });

  it('agent-run refusals are explained only for agent runs', () => {
    const steps = [step({ error: 'AGENT_RUN_PUSH_POLICY: x', status: 'FAILED' })];
    expect(deriveRunVerdict(run({ isAgentRun: true, status: 'FAILED', steps })).headline).toBe(
      'Refused by the push policy'
    );
    expect(deriveRunVerdict(run({ status: 'FAILED', steps })).headline).toBe('Failed');
  });

  it('cancelled and skipped state only what the status says', () => {
    expect(deriveRunVerdict(run({ status: 'CANCELLED' })).headline).toBe('Cancelled');
    const skipped = deriveRunVerdict(run({ status: 'SKIPPED' }));
    expect(skipped.headline).toBe('Skipped');
    expect(skipped.tone).toBe('info');
    expect(skipped.detail).not.toContain('without doing the work');
  });

  it('a failed step on a successful run does not turn it into a failure', () => {
    const v = deriveRunVerdict(run({ steps: [step({ error: 'warned', status: 'FAILED' })] }));
    expect(v.tone).toBe('success');
  });
});
