import type { HumanStepSummary, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { WHO_UNKNOWN, WHO_UNKNOWN_MANY, whoCanAnswer } from './gateAnswerers';
import { deriveRunVerdict, toPendingHumanSteps, type VerdictRun } from './runVerdict';

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

const NOW = Date.parse('2026-11-24T12:00:00Z');
const PAST = '2026-11-24T11:00:00Z';
const FUTURE = '2026-11-24T13:00:00Z';
const WHO_PAYMENTS = whoCanAnswer('Payments');

function pendingDetail(steps: Parameters<typeof deriveRunVerdict>[1]): string {
  return deriveRunVerdict(run({ status: 'RUNNING' }), steps, NOW).detail;
}

describe('who can answer a pending gate', () => {
  it('says nothing about people when canAnswer is unknown', () => {
    const d = pendingDetail([{ ownerTeamName: 'Payments', title: 'Approve' }]);
    expect(d).not.toMatch(/You can|You cannot|You answered|deadline|Answerers|who can answer/);
  });

  it('says so plainly when the viewer can answer', () => {
    const d = pendingDetail([{ canAnswer: true, ownerTeamName: 'Payments', title: 'Approve' }]);
    expect(d).toContain(' You can answer it.');
    expect(d).not.toContain('Answerers');
  });

  it('says the viewer answered and how many more are needed, once', () => {
    const d = pendingDetail([
      {
        approvalsRemaining: 1,
        canAnswer: false,
        currentApprovers: 1,
        kind: 'APPROVAL',
        myResponse: 'approve',
        requiredApprovers: 2,
        title: 'Approve',
      },
    ]);
    expect(d).toContain('You answered; it needs 1 more from other people.');
    expect(d).not.toContain('It still needs');
    expect(d).not.toContain('Answerers');
  });

  it('states the general rule, briefly, when the viewer cannot answer', () => {
    const d = pendingDetail([{ canAnswer: false, ownerTeamName: 'Payments', title: 'Approve' }]);
    expect(d).toContain(` You cannot answer it. ${WHO_PAYMENTS}`);
    expect(d).toContain('members of Payments (with repository access when GitHub');
    expect(d).not.toMatch(/no control|do not control|controlled by|right now/);
  });

  it('says the platform does not record who can answer when the owner team is unknown', () => {
    const d = pendingDetail([{ canAnswer: false, title: 'Approve' }]);
    expect(d).toContain(` You cannot answer it. ${WHO_UNKNOWN}`);
    expect(d).not.toContain('members of');
  });

  it('uses the plural unknown wording for several gates', () => {
    const d = pendingDetail([
      { canAnswer: false, title: 'A' },
      { canAnswer: false, title: 'B' },
    ]);
    expect(d).toContain(` You cannot answer them. ${WHO_UNKNOWN_MANY}`);
  });

  it('any answerable gate wins among several', () => {
    const d = pendingDetail([
      { canAnswer: false, title: 'A' },
      { canAnswer: true, title: 'B' },
      { canAnswer: true, title: 'C' },
    ]);
    expect(d).toContain('You can answer 2 of them.');
    expect(
      pendingDetail([
        { canAnswer: true, title: 'A' },
        { canAnswer: true, title: 'B' },
      ])
    ).toContain('You can answer all of them.');
  });

  it('stays quiet about people when no gate is answerable and one is unknown', () => {
    const d = pendingDetail([{ canAnswer: false, title: 'A' }, { title: 'B' }]);
    expect(d).not.toMatch(/You can|You cannot|You answered|Answerers/);
  });

  it('keeps mixed states truthful: answered gates and gates it cannot answer', () => {
    const d = pendingDetail([
      { canAnswer: false, myResponse: 'approve', title: 'A' },
      { canAnswer: false, ownerTeamName: 'Payments', title: 'B' },
    ]);
    expect(d).toContain('You answered 1 of them.');
    expect(d).toContain(`You cannot answer the other. ${WHO_PAYMENTS}`);
  });

  it.each([
    [1, 'You cannot answer the other.'],
    [2, 'You cannot answer the others.'],
    [3, 'You cannot answer the others.'],
  ])('words %i other gates grammatically after an answered one', (others, phrase) => {
    const d = pendingDetail([
      { canAnswer: false, myResponse: 'approve', title: 'A' },
      ...Array.from({ length: others }, (_, i) => ({
        canAnswer: false,
        ownerTeamName: 'Payments',
        title: `B${i}`,
      })),
    ]);
    expect(d).toContain(phrase);
    expect(d).toContain('You answered 1 of them.');
    expect(d).toContain(`more gate${others + 1 > 2 ? 's' : ''}`);
  });

  it.each([
    [1, ' You cannot answer it.'],
    [2, ' You cannot answer them.'],
    [5, ' You cannot answer them.'],
  ])('words %i unanswerable gates with no other state', (count, phrase) => {
    const d = pendingDetail(
      Array.from({ length: count }, (_, i) => ({
        canAnswer: false,
        ownerTeamName: 'Payments',
        title: `G${i}`,
      }))
    );
    expect(d).toContain(phrase);
    expect(d).not.toContain('You answered');
  });

  it('names each distinct owner team once when the gates differ', () => {
    const d = pendingDetail([
      { canAnswer: false, ownerTeamName: 'Payments', title: 'A' },
      { canAnswer: false, ownerTeamName: 'Design', title: 'B' },
      { canAnswer: false, ownerTeamName: 'Payments', title: 'C' },
    ]);
    expect(d).toContain('members of Payments or Design (with repository access');
  });

  it('uses a later gate team when the first gate names none', () => {
    const d = pendingDetail([
      { canAnswer: false, ownerTeamName: '  ', title: 'A' },
      { canAnswer: false, ownerTeamName: 'Design', title: 'B' },
    ]);
    expect(d).toContain('members of Design (with repository access');
  });

  it('never names a person or claims an approver exists, in any branch', () => {
    // The fixture carries a person's name on the step; the verdict must not repeat it.
    const base = {
      id: 's1',
      kind: 'APPROVAL',
      nodeId: 'gate',
      requestedAt: '2026-11-24T10:00:00Z',
      responses: [{ action: 'approve', byName: 'Zelda Quill', comment: null, resolvedAt: null }],
      run: {
        id: 'r1',
        ownerTeam: { id: 't', name: 'Payments', slug: 'p' },
        status: 'RUNNING',
        workflowId: 'w',
      },
      runId: 'r1',
      status: 'PENDING',
      title: 'Approve',
    } as HumanStepSummary;
    for (const canAnswer of [true, false, undefined]) {
      const d = pendingDetail(toPendingHumanSteps([{ ...base, canAnswer }]));
      expect(d).not.toContain('Zelda');
      expect(d).not.toMatch(/waiting on [A-Z]|assigned to|requested by|requester|named approver/i);
    }
  });

  it('an ended run ignores gates and success still avoids waiting language', () => {
    const gate = [{ canAnswer: false, ownerTeamName: 'Payments', title: 'A' }];
    expect(deriveRunVerdict(run({ status: 'SUCCESS' }), gate).detail).not.toMatch(
      /waiting|waits|Answerers/i
    );
    expect(deriveRunVerdict(run({ status: 'FAILED' }), gate).detail).not.toContain('Answerers');
  });
});

describe('a gate past its deadline', () => {
  it('says the deadline passed, not who can answer, even for a viewer the rule includes', () => {
    // The server reports canAnswer false for everyone once a still-pending gate is expired,
    // an admin or a member of the owning team included.
    const d = pendingDetail([
      { canAnswer: false, ownerTeamName: 'Payments', timeoutAt: PAST, title: 'Approve' },
    ]);
    expect(d).toContain(' The deadline for responding has passed.');
    expect(d).not.toMatch(/You cannot answer|Answerers|members of|who can answer/);
  });

  it('is judged against the injected clock', () => {
    const step = { canAnswer: false, timeoutAt: '2026-11-24T12:00:00Z', title: 'A' };
    expect(deriveRunVerdict(run({ status: 'RUNNING' }), [step], NOW - 1).detail).toContain(
      'You cannot answer it.'
    );
    expect(deriveRunVerdict(run({ status: 'RUNNING' }), [step], NOW).detail).toContain(
      'The deadline for responding has passed.'
    );
  });

  it.each([
    ['null', null],
    ['absent', undefined],
    ['future (clock skew)', FUTURE],
    ['unparseable', 'not-a-date'],
  ])('falls back to the general rule when timeoutAt is %s', (_label, timeoutAt) => {
    const d = pendingDetail([
      { canAnswer: false, ownerTeamName: 'Payments', timeoutAt, title: 'A' },
    ]);
    expect(d).toContain(`You cannot answer it. ${WHO_PAYMENTS}`);
    expect(d).not.toContain('deadline');
  });

  it('stays truthful when only some gates are past their deadline', () => {
    const d = pendingDetail([
      { canAnswer: false, ownerTeamName: 'Payments', timeoutAt: PAST, title: 'A' },
      { canAnswer: false, ownerTeamName: 'Payments', timeoutAt: FUTURE, title: 'B' },
    ]);
    expect(d).toContain('The deadline for responding has passed on 1 of them.');
    expect(d).toContain(`You cannot answer the other. ${WHO_PAYMENTS}`);
  });

  it('says so for every gate when all are expired', () => {
    const d = pendingDetail([
      { canAnswer: false, timeoutAt: PAST, title: 'A' },
      { canAnswer: false, timeoutAt: PAST, title: 'B' },
    ]);
    expect(d).toContain('The deadline for responding has passed on all of them.');
    expect(d).not.toContain('You cannot answer');
  });

  it('an answerable gate still wins over an expired one', () => {
    const d = pendingDetail([
      { canAnswer: false, timeoutAt: PAST, title: 'A' },
      { canAnswer: true, title: 'B' },
    ]);
    expect(d).toContain('You can answer 1 of them.');
    expect(d).not.toContain('deadline');
  });

  it('an answered gate is reported as answered, not as expired', () => {
    const d = pendingDetail([
      { canAnswer: false, myResponse: 'approve', timeoutAt: PAST, title: 'A' },
    ]);
    expect(d).toContain('You answered it.');
    expect(d).not.toContain('deadline');
  });
});

describe('toPendingHumanSteps', () => {
  function step(over: Partial<HumanStepSummary> & { ownerTeamName?: string | null } = {}) {
    const { ownerTeamName, ...rest } = over;
    return {
      id: 's1',
      kind: 'APPROVAL',
      nodeId: 'gate',
      requestedAt: '2026-11-24T10:00:00Z',
      run: {
        id: 'r1',
        ownerTeam: ownerTeamName ? { id: 't', name: ownerTeamName, slug: 't' } : null,
        status: 'RUNNING',
        workflowId: 'w1',
      },
      runId: 'r1',
      status: 'PENDING',
      title: 'Approve',
      ...rest,
    } as HumanStepSummary;
  }

  it('carries the fields the verdict reads, including canAnswer, myResponse and timeoutAt', () => {
    const [mapped] = toPendingHumanSteps([
      step({
        approvalsRemaining: 1,
        canAnswer: false,
        currentApprovers: 1,
        myResponse: 'approve',
        ownerTeamName: 'Payments',
        requiredApprovers: 2,
        timeoutAt: PAST,
      }),
    ]);
    expect(mapped).toEqual({
      approvalsRemaining: 1,
      canAnswer: false,
      currentApprovers: 1,
      kind: 'APPROVAL',
      myResponse: 'approve',
      ownerTeamName: 'Payments',
      requiredApprovers: 2,
      timeoutAt: PAST,
      title: 'Approve',
    });
  });

  it("prefers the step's own owner team over the run's", () => {
    const [mapped] = toPendingHumanSteps([step({ ownerTeamName: 'Payments' })], 'Design');
    expect(mapped.ownerTeamName).toBe('Payments');
  });

  it("falls back to the run's owner team, and then to null", () => {
    expect(toPendingHumanSteps([step()], 'Design')[0].ownerTeamName).toBe('Design');
    expect(toPendingHumanSteps([step()], null)[0].ownerTeamName).toBeNull();
    expect(toPendingHumanSteps([step()])[0].ownerTeamName).toBeNull();
  });

  it('keeps canAnswer unknown when the payload omits it, so the verdict stays quiet', () => {
    const mapped = toPendingHumanSteps([step()], 'Design');
    expect(mapped[0].canAnswer).toBeUndefined();
    expect(pendingDetail(mapped)).not.toMatch(/You can|You cannot/);
  });
});

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
