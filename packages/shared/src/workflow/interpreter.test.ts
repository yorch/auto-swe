import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINEERING_SPEC } from './defaultEngineeringSpec.js';
import type { Context } from './expr.js';
import { BranchCancelledError, type Dispatcher, runSpec } from './interpreter.js';
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
  /**
   * If set, mocks Temporal-style cancellation. The dispatcher honors the
   * `cancellation` sink the interpreter passes in: it installs a token that
   * rejects the in-flight promise with `Error('cancelled')` when called.
   */
  supportsCancellation?: boolean;
}): {
  dispatcher: Dispatcher;
  calls: Call[];
  records: Array<{ nodeId: string; status: string }>;
} {
  const calls: Call[] = [];
  const records: Array<{ nodeId: string; status: string }> = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, inputs, config, cancellation }) {
      const merged = { ...config, ...inputs };
      calls.push({ config: { ...config }, inputs: merged, step });
      // The engineering spec resolves CI-wait config before the CI gate. Parity
      // tests exercise the default webhook (signal) path, so default this config
      // step to signal mode unless a test overrides it (poll-mode routing is
      // covered in defaultEngineeringSpec.ciwait.test.ts).
      const out =
        opts.stepOutputs[step] ??
        (step === 'resolveCiWaitConfig'
          ? { deadlineSec: 600, graceSec: 60, intervalSec: 15, mode: 'signal' }
          : undefined);
      if (out === undefined) {
        throw new Error(`no canned output for step ${step}`);
      }
      const raw =
        typeof out === 'function' ? (out as (i: Record<string, unknown>) => unknown)(merged) : out;
      if (!opts.supportsCancellation || !cancellation) {
        return raw;
      }
      // Mock: race the canned output against the cancellation token. Mirrors
      // the Temporal dispatcher's contract — it rethrows CancelledFailure
      // as a BranchCancelledError so the interpreter can bypass onFail.
      return new Promise((resolve, reject) => {
        cancellation.token = {
          cancel: () => reject(new BranchCancelledError()),
        };
        Promise.resolve(raw).then(resolve, reject);
      });
    },
    async recordStep({ nodeId, status }) {
      records.push({ nodeId, status });
    },
    async waitSignal(name) {
      const q = opts.signalQueue[name];
      if (!q || q.length === 0) {
        return undefined;
      }
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
    await expect(runSpec(spec, baseCtx(), dispatcher, { maxTransitions: 50 })).rejects.toThrow(
      /MAX_NODE_TRANSITIONS/
    );
  });

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

  // ── Phase 3: fanOut semantics ──

  it('fanOut: runs the subgraph once per element and aggregates results', async () => {
    const spec = parseWorkflowSpec({
      entry: 'init',
      name: 'fanout-basic',
      nodes: {
        branchDone: {
          result: { branch: { from: 'context.localBranch' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        done: {
          result: {
            count: { from: 'nodes.fan.output.count' },
            failed: { from: 'nodes.fan.output.failed' },
            succeeded: { from: 'nodes.fan.output.succeeded' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          exports: ['context.localBranch'],
          join: 'done',
          over: { from: 'context.items' },
          subgraph: 'recordBranch',
          type: 'fanOut',
        },
        init: {
          next: 'fan',
          type: 'set',
          values: {
            'context.items': {
              literal: [
                { id: 'a', title: 'first' },
                { id: 'b', title: 'second' },
                { id: 'c', title: 'third' },
              ],
            },
          },
        },
        recordBranch: {
          next: 'branchDone',
          type: 'set',
          values: {
            'context.localBranch': { from: 'subtask.id' },
          },
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.count).toBe(3);
    expect(result.result.succeeded).toBe(3);
    expect(result.result.failed).toBe(0);
    // Verify per-branch result + exports landed under nodes.fan.output.
    const out = (result.finalContext.nodes as Record<string, { output?: unknown }>).fan?.output as {
      results: Array<{ result: { branch: string }; exports?: Record<string, unknown> }>;
    };
    expect(out.results.map((r) => r.result.branch)).toEqual(['a', 'b', 'c']);
    expect(out.results[0]?.exports).toEqual({ 'context.localBranch': 'a' });
  });

  it('fanOut: bounds branches by the caller-supplied concurrency when the node sets none', async () => {
    // The registry-pinned width. The node has no `concurrency` of its own, so
    // whatever runSpec was handed is what bounds the fan-out.
    const spec = parseWorkflowSpec({
      entry: 'init',
      name: 'fanout-concurrency',
      nodes: {
        branchDone: { result: {}, status: 'SUCCESS', type: 'terminate' },
        done: { result: {}, status: 'SUCCESS', type: 'terminate' },
        fan: { join: 'done', over: { from: 'context.items' }, subgraph: 'work', type: 'fanOut' },
        init: {
          next: 'fan',
          type: 'set',
          values: { 'context.items': { literal: [1, 2, 3, 4, 5, 6, 7, 8] } },
        },
        work: { next: 'branchDone', step: 'slow', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });

    let inFlight = 0;
    let peak = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        // Async on purpose: a synchronous step never overlaps, so peak would
        // read 1 regardless of the limit and the assertion would prove nothing.
        slow: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return {};
        },
      },
    });

    const result = await runSpec(spec, baseCtx(), dispatcher, { fanoutConcurrency: 2 });
    expect(result.status).toBe('SUCCESS');
    expect(peak).toBe(2);
  });

  it('fanOut: a later subgraph node binds nodes.<subgraphStep>.output by its spec key', async () => {
    // Inside a branch the step row is RECORDED under the prefixed id
    // (`fan[0]/work`) so workflow_steps disambiguates, but the CONTEXT write
    // must land under the spec key — that is what a sibling `set`/`cond`/
    // `terminate` binding in the same branch reads. Storing it under the
    // prefixed id makes every `nodes.<id>.output` binding inside a subgraph
    // silently resolve to undefined.
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-branch-binding',
      nodes: {
        branchDone: {
          result: { fromStep: { from: 'nodes.work.output.value' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        branchFailed: { status: 'FAILED', type: 'terminate' },
        checkWork: {
          expr: 'nodes.work.output.value > 0',
          onFalse: 'branchFailed',
          onTrue: 'stash',
          type: 'cond',
        },
        done: {
          result: { results: { from: 'nodes.fan.output.results' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          exports: ['context.stashed'],
          join: 'done',
          over: { literal: [1, 2] },
          subgraph: 'work',
          type: 'fanOut',
        },
        stash: {
          next: 'branchDone',
          type: 'set',
          values: { 'context.stashed': { from: 'nodes.work.output.value' } },
        },
        work: {
          inputs: { n: { from: 'subtask' } },
          next: 'checkWork',
          step: 'compute',
          type: 'step',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { compute: (i: Record<string, unknown>) => ({ value: (i.n as number) * 10 }) },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    const results = result.result.results as Array<{
      status: string;
      result: { fromStep: unknown };
      exports?: Record<string, unknown>;
    }>;
    expect(results.map((r) => r.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(results.map((r) => r.result.fromStep)).toEqual([10, 20]);
    expect(results.map((r) => r.exports)).toEqual([
      { 'context.stashed': 10 },
      { 'context.stashed': 20 },
    ]);
    // Recording still carries the branch prefix so step rows disambiguate.
    expect(records.filter((r) => r.status === 'PASSED').map((r) => r.nodeId)).toEqual(
      expect.arrayContaining(['fan[0]/work', 'fan[1]/work'])
    );
    expect(records.some((r) => r.nodeId === 'work')).toBe(false);
  });

  it('fanOut: describes the branch at `fanOut.{itemKey,index}` for executors', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-item-key',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          itemKey: 'story',
          join: 'done',
          over: { literal: ['a', 'b'] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: {
          inputs: { i: { from: 'fanOut.index' }, k: { from: 'fanOut.itemKey' } },
          next: 'branchDone',
          step: 'echo',
          type: 'step',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { echo: { ok: true } },
    });
    await runSpec(spec, baseCtx(), dispatcher);
    expect(calls.map((c) => [c.inputs.k, c.inputs.i])).toEqual([
      ['story', 0],
      ['story', 1],
    ]);
  });

  it('fanOut: sealed child context — branch writes do not leak to parent', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-seal',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: { parentLeak: { from: 'context.leak' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          join: 'done',
          over: { literal: ['x', 'y'] },
          subgraph: 'leak',
          type: 'fanOut',
        },
        leak: {
          next: 'branchDone',
          type: 'set',
          values: { 'context.leak': { literal: 'mutated' } },
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    // Parent context.leak never set — the branch mutated its own sealed copy.
    expect(result.result.parentLeak).toBeUndefined();
  });

  it('fanOut: subgraph step dispatch sees the bound itemKey via inputs', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-step',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        echo: {
          inputs: { item: { from: 'subtask' } },
          next: 'branchDone',
          step: 'echo',
          type: 'step',
        },
        fan: {
          join: 'done',
          over: { literal: ['alpha', 'beta'] },
          subgraph: 'echo',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const calls: unknown[] = [];
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        echo: (i: Record<string, unknown>) => {
          calls.push(i.item);
          return { ok: true };
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls).toEqual(['alpha', 'beta']);
    // Branch-prefixed nodeIds in records distinguish the two echo invocations.
    const echoRecords = records.filter((r) => r.nodeId.endsWith('/echo') || r.nodeId === 'echo');
    expect(echoRecords.length).toBeGreaterThanOrEqual(2);
    expect(echoRecords[0]?.nodeId).toMatch(/fan\[0\]\/echo/);
    expect(echoRecords[1]?.nodeId).toMatch(/fan\[1\]\/echo/);
  });

  it('fanOut: onBranchFail=block aborts the run on the first branch failure', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-block',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        explode: { next: 'branchDone', step: 'boom', type: 'step' },
        fan: {
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [1, 2, 3] },
          subgraph: 'explode',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        boom: () => {
          throw new Error('subagent crashed');
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('subagent crashed');
  });

  it('fanOut: onBranchFail=continue records failed branches and proceeds', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-continue',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: {
            failed: { from: 'nodes.fan.output.failed' },
            succeeded: { from: 'nodes.fan.output.succeeded' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          join: 'done',
          onBranchFail: 'continue',
          over: { literal: [0, 1, 2] },
          subgraph: 'maybeFail',
          type: 'fanOut',
        },
        maybeFail: { next: 'branchDone', step: 'flaky', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let n = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        flaky: () => {
          const i = n++;
          if (i === 1) {
            throw new Error('odd one out');
          }
          return { ok: true };
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.succeeded).toBe(2);
    expect(result.result.failed).toBe(1);
  });

  it('fanOut: throws when `over` does not resolve to an array', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-bad-over',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          over: { literal: 'not an array' },
          subgraph: 'branchDone',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(/must resolve to an array/);
    expect(records.filter((r) => r.nodeId === 'fan' && r.status === 'FAILED')).toHaveLength(1);
  });

  it('fanOut: a block-mode failure records exactly ONE FAILED row for the fanOut', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-block-single-record',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [0] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'boom', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        boom: () => {
          throw new Error('kaboom');
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('kaboom');
    // runFanOut records the aggregate FAILED row itself; walk's catch must not
    // add a second one without the aggregate.
    expect(records.filter((r) => r.nodeId === 'fan' && r.status === 'FAILED')).toHaveLength(1);
  });

  it('fanOut: empty array short-circuits to the join (count=0, no branch records)', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-empty',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: { count: { from: 'nodes.fan.output.count' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        explode: { next: 'branchDone', step: 'never', type: 'step' },
        fan: {
          join: 'done',
          over: { literal: [] },
          subgraph: 'explode',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        never: () => {
          throw new Error('should not be called');
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.count).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('fanOut: pluck projects each branch result entry into output.plucked', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-pluck',
      nodes: {
        branchDone: {
          result: { branch: { from: 'subtask.id' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        done: {
          result: { plucked: { from: 'nodes.fan.output.plucked' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
          pluck: 'result.branch',
          subgraph: 'branchDone',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.result.plucked).toEqual(['a', 'b', 'c']);
  });

  it('fanOut: onBranchFail=block aborts when a branch terminates with FAILED (no throw)', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-block-on-terminate-failed',
      nodes: {
        branchFailed: { status: 'FAILED', type: 'terminate' },
        branchOk: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [0, 1, 2] },
          subgraph: 'pickTerminal',
          type: 'fanOut',
        },
        // index 1 takes the FAILED terminate via cond.
        pickTerminal: {
          expr: 'subtaskIndex == 1',
          onFalse: 'branchOk',
          onTrue: 'branchFailed',
          type: 'cond',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({ signalQueue: {}, stepOutputs: {} });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(
      /terminated with status FAILED/
    );
  });

  // ── Phase 3.5: parallel fan-out semantics ──

  it('fanOut: runs branches in parallel and caps in-flight count to `concurrency`', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-cap',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: {
            count: { from: 'nodes.fan.output.count' },
            succeeded: { from: 'nodes.fan.output.succeeded' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          concurrency: 2,
          join: 'done',
          over: { literal: [0, 1, 2, 3, 4] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'work', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let active = 0;
    let maxActive = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        work: () => {
          active++;
          maxActive = Math.max(maxActive, active);
          // Schedule decrement asynchronously so the worker actually yields
          // and the next item can be picked up. Returning a promise from a
          // step output is supported by the dispatcher's `out(merged)` path.
          return Promise.resolve().then(() => {
            active--;
            return { ok: true };
          });
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.count).toBe(5);
    expect(result.result.succeeded).toBe(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // confirms parallelism actually happened
  });

  it('fanOut: aggregate preserves item-index order even when branches finish out of order', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-order',
      nodes: {
        branchDone: {
          result: { id: { from: 'subtask' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        done: {
          result: { plucked: { from: 'nodes.fan.output.plucked' } },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          concurrency: 4,
          join: 'done',
          over: { literal: ['a', 'b', 'c', 'd'] },
          pluck: 'result.id',
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'echo', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    // Resolve in reverse order: index 3 first, index 0 last.
    const order = ['a', 'b', 'c', 'd'];
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        echo: (i: Record<string, unknown>) => {
          const idx = order.indexOf(i.subtask as string);
          // Wrap in a chain of resolved promises so later indexes settle first.
          let p: Promise<unknown> = Promise.resolve({ ok: true });
          for (let k = 0; k < idx; k++) {
            p = p.then((v) => Promise.resolve(v));
          }
          return p;
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.result.plucked).toEqual(['a', 'b', 'c', 'd']);
  });

  it('fanOut: onBranchFail=continue runs every branch and reports skipped=0', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-continue-skipped',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: {
            failed: { from: 'nodes.fan.output.failed' },
            skipped: { from: 'nodes.fan.output.skipped' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          concurrency: 2,
          join: 'done',
          onBranchFail: 'continue',
          over: { literal: [0, 1, 2, 3, 4, 5] },
          subgraph: 'flaky',
          type: 'fanOut',
        },
        flaky: { next: 'branchDone', step: 'maybe', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let n = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        maybe: () => {
          const i = n++;
          if (i === 2) {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve({ ok: true });
        },
      },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(result.result.failed).toBe(1);
    expect(result.result.skipped).toBe(0);
  });

  it('fanOut: defaults to DEFAULT_FANOUT_CONCURRENCY when unset', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-default-cap',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          over: { literal: [0, 1, 2, 3, 4, 5, 6, 7] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'work', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let active = 0;
    let maxActive = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        work: () => {
          active++;
          maxActive = Math.max(maxActive, active);
          return Promise.resolve().then(() => {
            active--;
            return { ok: true };
          });
        },
      },
    });
    await runSpec(spec, baseCtx(), dispatcher);
    // DEFAULT_FANOUT_CONCURRENCY is 4.
    expect(maxActive).toBeLessThanOrEqual(4);
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

  // ── Phase 8: activity cancellation in fan-out block-mode ──

  it('fanOut block-mode cancels sibling branches when one fails (phase 8)', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-cancel',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: {
          result: {
            count: { from: 'nodes.fan.output.count' },
            failed: { from: 'nodes.fan.output.failed' },
            skipped: { from: 'nodes.fan.output.skipped' },
          },
          status: 'SUCCESS',
          type: 'terminate',
        },
        fan: {
          concurrency: 3,
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [0, 1, 2] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'maybeCancel', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });

    let n = 0;
    const slowResolvers: Array<(v: unknown) => void> = [];
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        // Branch 0 fails fast; branches 1+2 park on `slowResolvers` so the
        // mock cancellation token has time to fire. Without cancellation
        // those branches would resolve successfully and the block-mode
        // surface would just be "we let them drain" — exactly what phase 8
        // fixes.
        maybeCancel: () => {
          const i = n++;
          if (i === 0) {
            return Promise.reject(new Error('branch 0 boom'));
          }
          return new Promise((resolve) => {
            slowResolvers.push(resolve);
          });
        },
      },
      supportsCancellation: true,
    });

    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('branch 0 boom');
    // No one resolved them — they were cancelled by the token plumbing.
    expect(slowResolvers.length).toBeGreaterThan(0);
  });

  it('fanOut block-mode stops a sibling that is between activities', async () => {
    // The cancellation token only reaches an activity that is in flight. A
    // sibling whose current step has already settled when the block fires must
    // not go on to dispatch its next one.
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-block-between',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 2,
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [0, 1] },
          subgraph: 'first',
          type: 'fanOut',
        },
        first: { inputs: { i: { from: 'subtask' } }, next: 'second', step: 'first', type: 'step' },
        second: { next: 'branchDone', step: 'second', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        // Branch 0 fails at once; branch 1's first step settles a tick later,
        // after the block has fired, and its branch must then stop.
        first: (i: Record<string, unknown>) =>
          i.i === 0
            ? Promise.reject(new Error('branch 0 boom'))
            : new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10)),
        second: { ok: true },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('branch 0 boom');
    expect(calls.filter((c) => c.step === 'second')).toHaveLength(0);
    // Branch 1's first step did complete — it was between activities, not cancelled mid-flight.
    expect(records).toContainEqual({ nodeId: 'fan[1]/first', status: 'PASSED' });
  });

  it('fanOut block-mode without dispatcher cancellation support still drains in-flight work', async () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout-block-drain',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          concurrency: 3,
          join: 'done',
          onBranchFail: 'block',
          over: { literal: [0, 1, 2] },
          subgraph: 'work',
          type: 'fanOut',
        },
        work: { next: 'branchDone', step: 'mixed', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });

    let n = 0;
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        mixed: () => {
          const i = n++;
          if (i === 0) {
            throw new Error('boom');
          }
          return { ok: true };
        },
      },
    });
    // No cancellation support: in-flight branches drain (phase 3.5 behavior).
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('boom');
  });

  it('BranchCancelledError bypasses onFail: warn at the step level (phase 8)', async () => {
    // If a step throws BranchCancelledError, the interpreter must NOT apply
    // onFail: 'warn' (which would swallow it and let the cancelled branch
    // continue). The check is a defensive carve-out for fan-out block-mode.
    const spec = parseWorkflowSpec({
      entry: 'work',
      name: 'cancel-bypass-onfail',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        // onFail: 'warn' would normally swallow a regular Error and continue.
        work: { next: 'done', onFail: 'warn', step: 'cancelMe', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        cancelMe: () => {
          throw new BranchCancelledError();
        },
      },
    });
    // The cancellation propagates instead of being warned past.
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(BranchCancelledError);
  });

  it('BranchCancelledError bypasses onFail: retry at the step level (phase 8)', async () => {
    let attempts = 0;
    const spec = parseWorkflowSpec({
      entry: 'work',
      name: 'cancel-bypass-retry',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        work: { next: 'done', onFail: { retry: 5 }, step: 'cancelMe', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        cancelMe: () => {
          attempts++;
          throw new BranchCancelledError();
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(BranchCancelledError);
    // Cancellation must NOT be retried — the worker pool already accounted for it.
    expect(attempts).toBe(1);
  });

  // ── Phase 6: shell node ──

  it('dispatches a shell node via dispatchShell and records PASSED', async () => {
    const spec = parseWorkflowSpec({
      entry: 'sh',
      name: 'shell-happy',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: {
          command: 'echo hi',
          image: 'alpine:latest',
          next: 'done',
          type: 'shell',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let invoked = 0;
    const records: Array<{ nodeId: string; status: string }> = [];
    const dispatcher: Dispatcher = {
      async dispatchShell({ node }) {
        invoked++;
        return { command: node.command, exitCode: 0, passed: true, summary: 'ok' };
      },
      async dispatchStep() {
        throw new Error('shell node should not call dispatchStep');
      },
      async recordStep({ nodeId, status }) {
        records.push({ nodeId, status });
      },
      async waitSignal() {
        return undefined;
      },
    };
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(invoked).toBe(1);
    expect(result.status).toBe('SUCCESS');
    expect(records.find((r) => r.nodeId === 'sh')?.status).toBe('PASSED');
  });

  it('shell node onFail:warn continues past a passed:false result', async () => {
    const spec = parseWorkflowSpec({
      entry: 'sh',
      name: 'shell-warn',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: {
          command: 'false',
          image: 'alpine:latest',
          next: 'done',
          onFail: 'warn',
          type: 'shell',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const records: Array<{ nodeId: string; status: string }> = [];
    const dispatcher: Dispatcher = {
      async dispatchShell() {
        return { exitCode: 1, passed: false, summary: 'nope' };
      },
      async dispatchStep() {
        throw new Error('unused');
      },
      async recordStep({ nodeId, status }) {
        records.push({ nodeId, status });
      },
      async waitSignal() {
        return undefined;
      },
    };
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(records.filter((r) => r.nodeId === 'sh').map((r) => r.status)).toEqual(['FAILED']);
  });

  it('shell node onFail:block throws on passed:false', async () => {
    const spec = parseWorkflowSpec({
      entry: 'sh',
      name: 'shell-block',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: {
          command: 'false',
          image: 'alpine:latest',
          next: 'done',
          onFail: 'block',
          type: 'shell',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const dispatcher: Dispatcher = {
      async dispatchShell() {
        return { exitCode: 1, passed: false, summary: 'denied' };
      },
      async dispatchStep() {
        throw new Error('unused');
      },
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(/denied/);
  });

  it('shell node retries up to N times under onFail:{retry}', async () => {
    const spec = parseWorkflowSpec({
      entry: 'sh',
      name: 'shell-retry',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: {
          command: 'echo',
          image: 'alpine:latest',
          next: 'done',
          onFail: { retry: 2 },
          type: 'shell',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let calls = 0;
    const records: Array<{ nodeId: string; status: string; attempt?: number }> = [];
    const dispatcher: Dispatcher = {
      async dispatchShell() {
        calls++;
        // Pass on the 3rd attempt (= 1 + retry:2)
        return calls === 3
          ? { exitCode: 0, passed: true, summary: 'ok' }
          : { exitCode: 1, passed: false, summary: 'fail' };
      },
      async dispatchStep() {
        throw new Error('unused');
      },
      async recordStep({ nodeId, status, attempt }) {
        records.push({ attempt, nodeId, status });
      },
      async waitSignal() {
        return undefined;
      },
    };
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls).toBe(3);
    const shRecords = records.filter((r) => r.nodeId === 'sh');
    expect(shRecords.map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'PASSED']);
  });

  it('shell node throws when the dispatcher has no dispatchShell handler', async () => {
    const spec = parseWorkflowSpec({
      entry: 'sh',
      name: 'shell-no-dispatch',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: { command: 'true', image: 'alpine:latest', next: 'done', type: 'shell' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const dispatcher: Dispatcher = {
      async dispatchStep() {
        throw new Error('unused');
      },
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow(/no dispatchShell/);
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

describe('agent node (P2)', () => {
  it('dispatches an agent node to the runAgentNode step with its agentRef', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'agent',
      nodes: {
        a: { agentRef: 'reviewer', next: 'done', type: 'agent', userMessage: 'review this' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runAgentNode: { text: 'looks good' } },
    });
    const result = await runSpec(spec, baseCtx(), dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls.map((c) => c.step)).toEqual(['runAgentNode']);
    expect(calls[0].config.agentRef).toBe('reviewer');
    expect(calls[0].config.userMessage).toBe('review this');
  });

  it('does not set config.steering when the dispatcher has no drainSteering hook', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'agent-no-steer',
      nodes: {
        a: { agentRef: 'reviewer', next: 'done', type: 'agent', userMessage: 'review this' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runAgentNode: { text: 'looks good' } },
    });
    await runSpec(spec, baseCtx(), dispatcher);
    expect(calls[0].config.steering).toBeUndefined();
  });

  it('drains steering into the next agent node and clears it for the one after', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'agent-steer',
      nodes: {
        a: { agentRef: 'reviewer', next: 'b', type: 'agent', userMessage: 'first' },
        b: { agentRef: 'reviewer', next: 'done', type: 'agent', userMessage: 'second' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runAgentNode: { text: 'ok' } },
    });
    // Two steering messages pending before the run; the first agent node drains
    // both, the second sees none (drain semantics).
    const pending = ['use the v2 endpoint', 'keep it backwards compatible'];
    (dispatcher as Dispatcher & { drainSteering(): string[] }).drainSteering = () =>
      pending.splice(0);

    await runSpec(spec, baseCtx(), dispatcher);

    expect(calls.map((c) => c.step)).toEqual(['runAgentNode', 'runAgentNode']);
    expect(calls[0].config.steering).toEqual([
      'use the v2 endpoint',
      'keep it backwards compatible',
    ]);
    expect(calls[1].config.steering).toBeUndefined();
  });

  it('dispatches an mcp node to the mcpCallTool step with connectionRef + tool', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'mcp',
      nodes: {
        a: { connectionRef: 'conn-1', next: 'done', tool: 'search_docs', type: 'mcp' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { mcpCallTool: { result: { hits: 2 } } },
    });
    const ctx = baseCtx();
    const result = await runSpec(spec, ctx, dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls.map((c) => c.step)).toEqual(['mcpCallTool']);
    expect(calls[0].config.connectionRef).toBe('conn-1');
    expect(calls[0].config.tool).toBe('search_docs');
    // Tool result binds at nodes.<id>.output like any step.
    expect((ctx.nodes as Record<string, { output: unknown }>).a.output).toEqual({
      result: { hits: 2 },
    });
  });

  it('dispatches a containerStep node to the runContainerStep step with image + command', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'container',
      nodes: {
        a: {
          command: 'node run.js',
          image: 'ghcr.io/acme/cap:1',
          next: 'done',
          type: 'containerStep',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, calls } = makeDispatcher({
      signalQueue: {},
      stepOutputs: { runContainerStep: { result: { done: true } } },
    });
    const ctx = baseCtx();
    const result = await runSpec(spec, ctx, dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls.map((c) => c.step)).toEqual(['runContainerStep']);
    expect(calls[0].config.image).toBe('ghcr.io/acme/cap:1');
    expect(calls[0].config.command).toBe('node run.js');
    expect((ctx.nodes as Record<string, { output: unknown }>).a.output).toEqual({
      result: { done: true },
    });
  });

  it('a throwing agent node records exactly ONE FAILED row (no double-record)', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'agent-error',
      nodes: {
        a: { agentRef: 'reviewer', next: 'done', type: 'agent', userMessage: 'analyze' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, records } = makeDispatcher({
      signalQueue: {},
      stepOutputs: {
        runAgentNode: () => {
          throw new Error('agent crashed');
        },
      },
    });
    await expect(runSpec(spec, baseCtx(), dispatcher)).rejects.toThrow('agent crashed');
    // Exactly one FAILED record for the agent node — runRetryable records it,
    // walk's catch should not double-record it.
    const agentFailures = records.filter((r) => r.nodeId === 'a' && r.status === 'FAILED');
    expect(agentFailures).toHaveLength(1);
  });
});
