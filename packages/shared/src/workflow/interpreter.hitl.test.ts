import { describe, expect, it } from 'vitest';
import type { Context } from './expr.js';
import { type Dispatcher, runSpec } from './interpreter.js';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';

/**
 * HITL-focused interpreter tests. The existing interpreter.test.ts covers
 * step/set/cond/signal/fanOut/shell; the four human-in-the-loop node types
 * (humanApproval, humanDecision, humanInput, humanReview) are covered here.
 *
 * Signals are answered from a FIFO queue keyed by signal name — the HITL
 * signal name is `hitl_${recordingId}` per the interpreter contract (the spec
 * key at the top level, the branch-prefixed id inside a fanOut). An empty /
 * missing queue means waitSignal returns undefined, which the interpreter
 * treats as a timeout.
 */

type Notification = NonNullable<Parameters<NonNullable<Dispatcher['notifyHumanStep']>>[0]>;
type Resolution = Parameters<NonNullable<Dispatcher['resolveHumanStep']>>[0];

function makeHitlDispatcher(signalQueue: Record<string, unknown[]>): {
  dispatcher: Dispatcher;
  records: Array<{ nodeId: string; status: string }>;
  notifications: Notification[];
  resolutions: Resolution[];
} {
  const records: Array<{ nodeId: string; status: string }> = [];
  const notifications: Notification[] = [];
  const resolutions: Resolution[] = [];
  const dispatcher: Dispatcher = {
    async dispatchStep() {
      throw new Error('HITL tests do not dispatch steps');
    },
    async notifyHumanStep(args) {
      notifications.push(args);
    },
    async recordStep({ nodeId, status }) {
      records.push({ nodeId, status });
    },
    async resolveHumanStep(args) {
      resolutions.push(args);
    },
    async waitSignal(name) {
      const q = signalQueue[name];
      if (!q || q.length === 0) {
        return undefined;
      }
      return q.shift();
    },
  };
  return { dispatcher, notifications, records, resolutions };
}

const baseCtx = (extraContext: Record<string, unknown> = {}): Context => ({
  context: { ...extraContext },
  nodes: {},
  request: { externalTicketId: 'TEST-1', repoId: 'repo-1' },
  workflow: { id: 'eng-test-1' },
});

// ── humanApproval ──

const approvalSpec: WorkflowSpec = parseWorkflowSpec({
  entry: 'gate',
  name: 'hitl-approval',
  nodes: {
    approved: {
      result: { edge: { literal: 'approved' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    gate: {
      contextFrom: 'context.plan',
      description: 'Review the plan before implementation',
      onApprove: 'approved',
      onReject: 'rejected',
      onTimeout: 'timedOut',
      timeout: '24h',
      title: 'Approve plan?',
      type: 'humanApproval',
    },
    rejected: {
      result: { edge: { literal: 'rejected' } },
      status: 'FAILED',
      type: 'terminate',
    },
    timedOut: { status: 'TIMED_OUT', type: 'terminate' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

describe('humanApproval', () => {
  it('routes to onApprove on an approve action and records the human step', async () => {
    const { dispatcher, notifications, records } = makeHitlDispatcher({
      hitl_gate: [{ action: 'approve', resolvedBy: 'user-1' }],
    });
    const result = await runSpec(approvalSpec, baseCtx({ plan: 'the plan' }), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.edge).toBe('approved');

    // notifyHumanStep fired with the right kind / signal / options shape
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      context: 'the plan',
      description: 'Review the plan before implementation',
      kind: 'APPROVAL',
      nodeId: 'gate',
      signalName: 'hitl_gate',
      title: 'Approve plan?',
    });
    expect(notifications[0]?.options).toBeUndefined();
    expect(notifications[0]?.fields).toBeUndefined();

    // PENDING recorded before the wait, PASSED after the response
    expect(records).toContainEqual({ nodeId: 'gate', status: 'PENDING' });
    expect(records).toContainEqual({ nodeId: 'gate', status: 'PASSED' });

    // payload lands under nodes.<id>.output
    const nodes = result.finalContext.nodes as Record<string, { output?: unknown }>;
    expect(nodes.gate?.output).toEqual({ action: 'approve', resolvedBy: 'user-1' });
  });

  it('routes to onReject on a reject action', async () => {
    const { dispatcher } = makeHitlDispatcher({ hitl_gate: [{ action: 'reject' }] });
    const result = await runSpec(approvalSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    expect(result.result.edge).toBe('rejected');
  });

  it('routes to onTimeout and marks the step TIMED_OUT when no signal arrives', async () => {
    const { dispatcher, records, resolutions } = makeHitlDispatcher({});
    const result = await runSpec(approvalSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(records).toContainEqual({ nodeId: 'gate', status: 'SKIPPED' });
    expect(resolutions).toEqual([{ nodeId: 'gate', status: 'TIMED_OUT' }]);
  });
});

// ── HITL inside a fanOut branch ──

describe('HITL nodes inside a fanOut branch', () => {
  const fanSpec: WorkflowSpec = parseWorkflowSpec({
    entry: 'fan',
    name: 'hitl-fanout',
    nodes: {
      branchApproved: { status: 'SUCCESS', type: 'terminate' },
      branchRejected: { status: 'FAILED', type: 'terminate' },
      done: {
        result: { results: { from: 'nodes.fan.output.results' } },
        status: 'SUCCESS',
        type: 'terminate',
      },
      fan: {
        join: 'done',
        onBranchFail: 'continue',
        over: { literal: ['a', 'b'] },
        subgraph: 'gate',
        type: 'fanOut',
      },
      gate: {
        onApprove: 'branchApproved',
        onReject: 'branchRejected',
        onTimeout: 'branchRejected',
        timeout: '1h',
        title: 'Approve this branch?',
        type: 'humanApproval',
      },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  });

  it('gives every branch its own signal name and human-step row', async () => {
    const { dispatcher, notifications, records } = makeHitlDispatcher({
      'hitl_fan[0]/gate': [{ action: 'approve' }],
      'hitl_fan[1]/gate': [{ action: 'reject' }],
    });
    const result = await runSpec(fanSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect((result.result.results as Array<{ status: string }>).map((r) => r.status)).toEqual([
      'SUCCESS',
      'FAILED',
    ]);
    // Two distinct rows — the pending-step index is unique per (run, nodeId),
    // so a shared `gate` row would let only the first branch be answered.
    expect(notifications.map((n) => [n.nodeId, n.signalName])).toEqual([
      ['fan[0]/gate', 'hitl_fan[0]/gate'],
      ['fan[1]/gate', 'hitl_fan[1]/gate'],
    ]);
    expect(
      records.filter((r) => r.status === 'PASSED' && r.nodeId !== 'fan').map((r) => r.nodeId)
    ).toEqual(['fan[0]/gate', 'fan[1]/gate']);
  });

  it('times out a branch under its own prefixed id', async () => {
    const { dispatcher, resolutions } = makeHitlDispatcher({
      'hitl_fan[0]/gate': [{ action: 'approve' }],
    });
    const result = await runSpec(fanSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(resolutions).toEqual([{ nodeId: 'fan[1]/gate', status: 'TIMED_OUT' }]);
  });
});

// ── humanDecision ──

const decisionSpec: WorkflowSpec = parseWorkflowSpec({
  entry: 'pick',
  name: 'hitl-decision',
  nodes: {
    aborted: {
      result: { edge: { literal: 'aborted' } },
      status: 'FAILED',
      type: 'terminate',
    },
    pick: {
      onTimeout: 'timedOut',
      options: [
        { label: 'Ship it', next: 'shipped', value: 'ship' },
        { label: 'Abort', next: 'aborted', value: 'abort' },
      ],
      storeAs: 'context.choice',
      timeout: '4h',
      title: 'Ship or abort?',
      type: 'humanDecision',
    },
    shipped: {
      result: { edge: { literal: 'shipped' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    timedOut: { status: 'TIMED_OUT', type: 'terminate' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

describe('humanDecision', () => {
  it('routes to the chosen option next edge and stores the payload via storeAs', async () => {
    const payload = { action: 'select', value: 'ship' };
    const { dispatcher, notifications } = makeHitlDispatcher({ hitl_pick: [payload] });
    const result = await runSpec(decisionSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.edge).toBe('shipped');
    expect((result.finalContext.context as Record<string, unknown>).choice).toEqual(payload);

    // Options forwarded to the notification (label + value, no next)
    expect(notifications[0]).toMatchObject({ kind: 'DECISION', signalName: 'hitl_pick' });
    expect(notifications[0]?.options).toEqual([
      { label: 'Ship it', value: 'ship' },
      { label: 'Abort', value: 'abort' },
    ]);
  });

  it('routes the negative option to its own edge', async () => {
    const { dispatcher } = makeHitlDispatcher({
      hitl_pick: [{ action: 'select', value: 'abort' }],
    });
    const result = await runSpec(decisionSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    expect(result.result.edge).toBe('aborted');
  });

  it('records FAILED (not PASSED) and routes onTimeout when the value matches no option', async () => {
    // The gateway rejects such a value before signalling; a payload that gets
    // here is malformed. It used to be recorded PASSED — a decision nobody made.
    const { dispatcher, records } = makeHitlDispatcher({
      hitl_pick: [{ action: 'select', value: 'not-an-option' }],
    });
    const result = await runSpec(decisionSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(records).toContainEqual({ nodeId: 'pick', status: 'FAILED' });
    expect(records).not.toContainEqual({ nodeId: 'pick', status: 'PASSED' });
    expect((result.finalContext.context as Record<string, unknown>).choice).toBeUndefined();
  });

  it('routes to onTimeout and marks the step TIMED_OUT on timeout', async () => {
    const { dispatcher, resolutions } = makeHitlDispatcher({});
    const result = await runSpec(decisionSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(resolutions).toEqual([{ nodeId: 'pick', status: 'TIMED_OUT' }]);
  });
});

// ── humanInput ──

const inputSpec: WorkflowSpec = parseWorkflowSpec({
  entry: 'form',
  name: 'hitl-input',
  nodes: {
    form: {
      fields: [
        { key: 'reason', label: 'Reason', required: true, type: 'text' },
        { key: 'severity', label: 'Severity', options: ['low', 'high'], type: 'select' },
      ],
      onSubmit: 'submitted',
      onTimeout: 'timedOut',
      storeAs: 'context.form',
      timeout: '1h',
      title: 'Provide details',
      type: 'humanInput',
    },
    submitted: {
      result: { edge: { literal: 'submitted' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    timedOut: { status: 'TIMED_OUT', type: 'terminate' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

describe('humanInput', () => {
  it('routes to onSubmit on submit and stores the form payload', async () => {
    const payload = { action: 'submit', value: { reason: 'hotfix', severity: 'high' } };
    const { dispatcher, notifications } = makeHitlDispatcher({ hitl_form: [payload] });
    const result = await runSpec(inputSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.edge).toBe('submitted');
    expect((result.finalContext.context as Record<string, unknown>).form).toEqual(payload);

    // Field definitions forwarded to the notification; no options for INPUT
    expect(notifications[0]).toMatchObject({ kind: 'INPUT', signalName: 'hitl_form' });
    expect(notifications[0]?.fields).toEqual([
      { key: 'reason', label: 'Reason', required: true, type: 'text' },
      { key: 'severity', label: 'Severity', options: ['low', 'high'], type: 'select' },
    ]);
    expect(notifications[0]?.options).toBeUndefined();
  });

  it('routes to onTimeout and marks the step TIMED_OUT on timeout', async () => {
    const { dispatcher, records, resolutions } = makeHitlDispatcher({});
    const result = await runSpec(inputSpec, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(records).toContainEqual({ nodeId: 'form', status: 'SKIPPED' });
    expect(resolutions).toEqual([{ nodeId: 'form', status: 'TIMED_OUT' }]);
  });
});

// ── humanReview ──

const reviewSpec: WorkflowSpec = parseWorkflowSpec({
  entry: 'review',
  name: 'hitl-review',
  nodes: {
    review: {
      contentFrom: 'context.draft',
      onSubmit: 'submitted',
      onTimeout: 'timedOut',
      storeAs: 'context.reviewed',
      timeout: '12h',
      title: 'Review the PR description',
      type: 'humanReview',
    },
    submitted: {
      result: { edge: { literal: 'submitted' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    timedOut: { status: 'TIMED_OUT', type: 'terminate' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

describe('humanReview', () => {
  it('passes contentFrom as the notification context and routes to onSubmit', async () => {
    const payload = { action: 'submit', value: 'edited description' };
    const { dispatcher, notifications } = makeHitlDispatcher({ hitl_review: [payload] });
    const result = await runSpec(
      reviewSpec,
      baseCtx({ draft: 'original description' }),
      dispatcher
    );
    expect(result.status).toBe('SUCCESS');
    expect(result.result.edge).toBe('submitted');
    expect((result.finalContext.context as Record<string, unknown>).reviewed).toEqual(payload);

    expect(notifications[0]).toMatchObject({
      context: 'original description',
      kind: 'REVIEW',
      nodeId: 'review',
      signalName: 'hitl_review',
    });
  });

  it('routes to onTimeout and marks the step TIMED_OUT on timeout', async () => {
    const { dispatcher, resolutions } = makeHitlDispatcher({});
    const result = await runSpec(reviewSpec, baseCtx({ draft: 'x' }), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(resolutions).toEqual([{ nodeId: 'review', status: 'TIMED_OUT' }]);
  });

  it('does not let a notifyHumanStep failure block the workflow', async () => {
    const signalQueue: Record<string, unknown[]> = {
      hitl_review: [{ action: 'submit', value: 'v' }],
    };
    const records: Array<{ nodeId: string; status: string }> = [];
    const dispatcher: Dispatcher = {
      async dispatchStep() {
        throw new Error('unused');
      },
      async notifyHumanStep() {
        throw new Error('slack is down');
      },
      async recordStep({ nodeId, status }) {
        records.push({ nodeId, status });
      },
      async waitSignal(name) {
        const q = signalQueue[name];
        return q && q.length > 0 ? q.shift() : undefined;
      },
    };
    const result = await runSpec(reviewSpec, baseCtx({ draft: 'x' }), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(records).toContainEqual({ nodeId: 'review', status: 'PASSED' });
  });
});
