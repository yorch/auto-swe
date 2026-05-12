import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINEERING_SPEC } from './defaultEngineeringSpec.js';
import type { Context } from './expr.js';
import { type Dispatcher, runSpec } from './interpreter.js';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from './spec.js';

interface Call {
  step: string;
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
}

/**
 * Mock dispatcher used by parity tests. Each step is stubbed to return a
 * canned output; signals are answered from a FIFO queue per signal name.
 *
 * Step outputs receive a merged `{...config, ...inputs}` object so tests can
 * read either config-time literals or runtime bindings without caring which.
 */
function makeDispatcher(opts: {
  stepOutputs: Record<string, unknown | ((inputs: Record<string, unknown>) => unknown)>;
  signalQueue: Record<string, unknown[]>;
}): { dispatcher: Dispatcher; calls: Call[]; records: Array<{ nodeId: string; status: string }> } {
  const calls: Call[] = [];
  const records: Array<{ nodeId: string; status: string }> = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs, config }) {
      const merged = { ...config, ...inputs };
      calls.push({ config: { ...config }, inputs: merged, step });
      const out = opts.stepOutputs[step];
      if (out === undefined) throw new Error(`no canned output for step ${step}`);
      return typeof out === 'function'
        ? (out as (i: Record<string, unknown>) => unknown)(merged)
        : out;
    },
    async recordStep({ nodeId, status }) {
      records.push({ nodeId, status });
    },
    async waitSignal(name) {
      const q = opts.signalQueue[name];
      if (!q || q.length === 0) return undefined;
      return q.shift();
    },
  };
  return { calls, dispatcher, records };
}

const baseCtx = (): Context => ({
  context: {},
  nodes: {},
  request: { externalTicketId: 'TEST-1', repoId: 'repo-1' },
  workflow: { id: 'eng-test-1' },
});

describe('runSpec', () => {
  it('walks a trivial linear spec', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'linear',
      nodes: {
        a: { next: 'done', step: 'noop', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { noop: { ok: true } },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls.map((c) => c.step)).toEqual(['noop']);
  });

  it('honors set + cond branches', async () => {
    const spec = parseWorkflowSpec({
      entry: 'init',
      name: 'cond',
      nodes: {
        check: {
          expr: 'context.count > 3',
          onFalse: 'low',
          onTrue: 'high',
          type: 'cond',
        },
        high: { result: { branch: { literal: 'high' } }, status: 'SUCCESS', type: 'terminate' },
        init: {
          next: 'check',
          type: 'set',
          values: { 'context.count': { literal: 5 } },
        },
        low: { result: { branch: { literal: 'low' } }, status: 'FAILED', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.branch).toBe('high');
  });

  it('loops via cond + set increment', async () => {
    const spec = parseWorkflowSpec({
      entry: 'init',
      name: 'loop',
      nodes: {
        check: { expr: 'context.i >= 3', onFalse: 'inc', onTrue: 'done', type: 'cond' },
        done: { result: { count: { from: 'context.i' } }, status: 'SUCCESS', type: 'terminate' },
        inc: { next: 'check', type: 'set', values: { 'context.i': { expr: 'context.i + 1' } } },
        init: { next: 'inc', type: 'set', values: { 'context.i': { literal: 0 } } },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.result.count).toBe(3);
  });

  it('skips a step with onError=continue when it throws', async () => {
    const spec = parseWorkflowSpec({
      entry: 'maybeFail',
      name: 'softfail',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        maybeFail: { next: 'done', onError: 'continue', step: 'boom', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        boom: () => {
          throw new Error('nope');
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(records).toContainEqual({ nodeId: 'maybeFail', status: 'SKIPPED' });
  });

  it('propagates step errors when onError defaults to fail', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fail',
      name: 'hardfail',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        fail: { next: 'done', step: 'boom', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        boom: () => {
          throw new Error('nope');
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('nope');
  });

  it('signal node takes onReceive branch when payload arrives', async () => {
    const spec = parseWorkflowSpec({
      entry: 'wait',
      name: 'sig',
      nodes: {
        ok: { result: { got: { from: 'context.ping' } }, status: 'SUCCESS', type: 'terminate' },
        timeout: { status: 'TIMED_OUT', type: 'terminate' },
        wait: {
          name: 'ping',
          onReceive: 'ok',
          onTimeout: 'timeout',
          storeAs: 'context.ping',
          timeout: '10s',
          type: 'signal',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: { ping: [{ passed: true }] },
      stepOutputs: {},
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.got).toEqual({ passed: true });
  });

  it('signal node takes onTimeout branch when nothing arrives', async () => {
    const spec = parseWorkflowSpec({
      entry: 'wait',
      name: 'sig-timeout',
      nodes: {
        ok: { status: 'SUCCESS', type: 'terminate' },
        timeout: { status: 'TIMED_OUT', type: 'terminate' },
        wait: {
          name: 'ping',
          onReceive: 'ok',
          onTimeout: 'timeout',
          timeout: '10s',
          type: 'signal',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
  });

  it('caps infinite loops via maxTransitions', async () => {
    const spec = parseWorkflowSpec({
      entry: 'loop',
      name: 'forever',
      nodes: {
        loop: { expr: 'true', onFalse: 'loop', onTrue: 'loop', type: 'cond' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    await expect(runSpec(spec, baseCtx(), dispatcher, 50)).rejects.toThrow(/MAX_NODE_TRANSITIONS/);
  });

  // ── Phase 2: onFail semantics ──

  it('onFail=block (default): a passed=false output throws and aborts the run', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-block',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', step: 'runLint', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runLint: { exitCode: 1, passed: false, summary: 'lint failed' } },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('lint failed');
  });

  it('onFail=warn: a passed=false output records FAILED but the run continues', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-warn',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', onFail: 'warn', step: 'runVulnScan', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runVulnScan: { exitCode: 2, passed: false, summary: 'CVE-2024-x' } },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(records).toContainEqual(expect.objectContaining({ nodeId: 'gate', status: 'FAILED' }));
  });

  it('onFail.retry: retries N times before falling back to block', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-retry',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', onFail: { retry: 2 }, step: 'runTests', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let calls = 0;
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        runTests: () => {
          calls++;
          return { exitCode: 1, passed: false, summary: 'flaky' };
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('flaky');
    // retry: 2 → 1 initial + 2 retries = 3 attempts before terminal failure.
    expect(calls).toBe(3);
    const failed = records.filter((r) => r.nodeId === 'gate' && r.status === 'FAILED');
    expect(failed.length).toBe(3);
  });

  it('onFail.retry: stops retrying as soon as a retry passes', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-retry-recover',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', onFail: { retry: 3 }, step: 'runTests', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        runTests: () => {
          calls++;
          return calls < 3
            ? { exitCode: 1, passed: false, summary: 'flaky' }
            : { exitCode: 0, passed: true, summary: 'ok' };
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls).toBe(3);
  });

  it('onFail=block: a thrown exception (not just passed=false) still aborts', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-throw',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', step: 'runLint', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        runLint: () => {
          throw new Error('docker exec failed');
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('docker exec failed');
  });

  it('a step returning passed=true continues without invoking onFail policy', async () => {
    const spec = parseWorkflowSpec({
      entry: 'gate',
      name: 'gate-pass',
      nodes: {
        done: {
          result: { ok: { from: 'nodes.gate.output.passed' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        gate: { next: 'done', onFail: 'block', step: 'runLint', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runLint: { exitCode: 0, passed: true, summary: 'ok' } },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.ok).toBe(true);
  });

  it('refuses to write through __proto__ / prototype / constructor segments', async () => {
    for (const danger of [
      '__proto__.polluted',
      'context.__proto__.polluted',
      'context.constructor.x',
      'context.prototype.x',
    ]) {
      const spec = parseWorkflowSpec({
        entry: 'attack',
        name: 'proto',
        nodes: {
          attack: { next: 'done', type: 'set', values: { [danger]: { literal: 1 } } },
          done: { status: 'SUCCESS', type: 'terminate' },
        },
        schemaVersion: SPEC_SCHEMA_VERSION,
      });
      const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
      await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(/reserved segment/);
      // Verify the prototype was not actually polluted by the failed attempt
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });
});

// ── Parity tests against DEFAULT_ENGINEERING_SPEC ──

describe('DEFAULT_ENGINEERING_SPEC', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(DEFAULT_ENGINEERING_SPEC)).not.toThrow();
  });

  it('happy path: validate → implement → approve → CI pass → human merge → done', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {
        ciPipelineSignal: [{ passed: true }],
        humanMergeSignal: [true],
      },
      stepOutputs: {
        commitToMemory: { lessonId: 'L1' },
        createOrUpdatePullRequest: { prNumber: 42, prUrl: 'https://x/pr/42' },
        executeImplementation: codeResult,
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: ['build passes'] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.prNumber).toBe(42);
    expect(result.result.prUrl).toBe('https://x/pr/42');
    // Verify ordered domain-state transitions match the hardcoded workflow.
    const statuses = calls
      .filter((c) => c.step === 'updateDomainState')
      .map((c) => c.inputs.status);
    expect(statuses).toEqual([
      'VALIDATING_CONTEXT',
      'IMPLEMENTING',
      'IN_REVIEW',
      'AWAITING_CI',
      'AWAITING_HUMAN_MERGE',
      'COMPLETED',
    ]);
  });

  it('review rejection retries up to MAX_REVIEW_RETRIES then FAILED', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    let reviewCalls = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        executeImplementation: codeResult,
        executeReviewFixImplementation: codeResult,
        runReviewNetwork: () => {
          reviewCalls++;
          return { approved: false, codeResult, rejectionSummary: 'bad', verdicts: [] };
        },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: [] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    // Engineering workflow: review runs once on initial code, then after each
    // of the first two retries → 3 total review calls before FAIL.
    expect(reviewCalls).toBe(3);
  });

  it('CI failure retries up to MAX_CI_RETRIES then FAILED', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    let ciFixCalls = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {
        ciPipelineSignal: [
          { logsUrl: 'l1', passed: false },
          { logsUrl: 'l2', passed: false },
          { logsUrl: 'l3', passed: false },
        ],
      },
      stepOutputs: {
        createOrUpdatePullRequest: { prNumber: 1, prUrl: 'p' },
        executeCIFixImplementation: () => {
          ciFixCalls++;
          return codeResult;
        },
        executeImplementation: codeResult,
        fetchCILogs: 'log text',
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: [] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('FAILED');
    expect(ciFixCalls).toBe(2); // 1st + 2nd retries; 3rd failure terminates
    expect(result.result.prNumber).toBe(1);
  });

  it('CI signal timeout terminates as TIMED_OUT', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    const { dispatcher } = makeDispatcher({
      signalQueue: { ciPipelineSignal: [] },
      stepOutputs: {
        createOrUpdatePullRequest: { prNumber: 7, prUrl: 'pp' },
        executeImplementation: codeResult,
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: [] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
    expect(result.result.prNumber).toBe(7);
  });

  it('non-blocking validateContext failure does not abort the run', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {
        ciPipelineSignal: [{ passed: true }],
        humanMergeSignal: [true],
      },
      stepOutputs: {
        commitToMemory: { lessonId: 'L' },
        createOrUpdatePullRequest: { prNumber: 1, prUrl: 'p' },
        executeImplementation: codeResult,
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: () => {
          throw new Error('jira timeout');
        },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(records).toContainEqual({ nodeId: 'validate', status: 'SKIPPED' });
  });

  it('commitToMemory failure is non-blocking — still completes successfully', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    const { dispatcher } = makeDispatcher({
      signalQueue: {
        ciPipelineSignal: [{ passed: true }],
        humanMergeSignal: [true],
      },
      stepOutputs: {
        commitToMemory: () => {
          throw new Error('pg down');
        },
        createOrUpdatePullRequest: { prNumber: 1, prUrl: 'p' },
        executeImplementation: codeResult,
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: [] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
  });

  it('human merge timeout returns TIMED_OUT', async () => {
    const codeResult = { branch: 'auto/TEST', diff: 'd', filesChanged: [], headSha: 'sha1' };
    const { dispatcher } = makeDispatcher({
      signalQueue: {
        ciPipelineSignal: [{ passed: true }],
        humanMergeSignal: [],
      },
      stepOutputs: {
        createOrUpdatePullRequest: { prNumber: 1, prUrl: 'p' },
        executeImplementation: codeResult,
        runReviewNetwork: { approved: true, codeResult, verdicts: [] },
        updateDomainState: (i: Record<string, unknown>) => ({ status: i.status }),
        validateContext: { contextSnapshotId: 'cs1', successCriteria: [] },
      },
    });
    const result = await runSpec(DEFAULT_ENGINEERING_SPEC, baseCtx(), dispatcher);
    expect(result.status).toBe('TIMED_OUT');
  });
});
