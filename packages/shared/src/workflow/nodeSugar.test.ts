import { describe, expect, it } from 'vitest';
import type { Context } from './expr.js';
import { BranchCancelledError, type Dispatcher, runSpec } from './interpreter.js';
import { nodeEdges, parseWorkflowSpec, readNodeEdge, setNodeEdge } from './spec.js';
import { validateSpec } from './validateSpec.js';

const mk = (nodes: Record<string, unknown>, entry = 'a') =>
  parseWorkflowSpec({ entry, name: 'sugar', nodes, schemaVersion: 1 });

const ctx0 = (): Context => ({ context: {}, nodes: {}, request: {}, workflow: { id: 'w' } });
const done = { status: 'SUCCESS', type: 'terminate' };

/** step name -> queue of outcomes ('throw' | value); the last one repeats. */
function harness(
  outcomes: Record<string, unknown[]>,
  extra: Partial<Dispatcher> = {}
): { d: Dispatcher; calls: string[]; records: Array<{ nodeId: string; status: string }> } {
  const calls: string[] = [];
  const records: Array<{ nodeId: string; status: string }> = [];
  const d: Dispatcher = {
    async dispatchStep({ step }) {
      calls.push(step);
      const q = outcomes[step] ?? [{}];
      const out = q.length > 1 ? q.shift() : q[0];
      if (out === 'throw') {
        throw new Error(`${step} boom`);
      }
      return out;
    },
    async recordStep({ nodeId, status }) {
      records.push({ nodeId, status });
    },
    async waitSignal() {
      return undefined;
    },
    ...extra,
  };
  return { calls, d, records };
}

describe('spec: new node fields', () => {
  it('round-trips the fields and old specs are unchanged', () => {
    const s = mk({
      a: {
        maxVisits: 3,
        next: 'done',
        onExhausted: { message: 'gave up', status: 'FAILED' },
        onFailure: 'fail',
        status: 'Working',
        step: 's',
        storeAs: 'context.out',
        type: 'step',
      },
      done,
      fail: { status: 'FAILED', type: 'terminate' },
    });
    const a = s.nodes.a as Record<string, unknown>;
    expect(a.storeAs).toBe('context.out');
    expect(a.onFailure).toBe('fail');
    expect(a.status).toBe('Working');
    expect(a.maxVisits).toBe(3);
    expect(a.onExhausted).toEqual({ message: 'gave up', status: 'FAILED' });
    expect(parseWorkflowSpec(JSON.parse(JSON.stringify(s)))).toEqual(s);

    const old = mk({ a: { next: 'done', step: 's', type: 'step' }, done });
    for (const k of ['storeAs', 'onFailure', 'status', 'maxVisits', 'onExhausted']) {
      expect(Object.hasOwn(old.nodes.a as object, k)).toBe(false);
    }
  });

  it('terminate keeps its terminal status', () => {
    expect(mk({ a: { status: 'TIMED_OUT', type: 'terminate' } }).nodes.a).toMatchObject({
      status: 'TIMED_OUT',
    });
    expect(() => mk({ a: { status: 'Working', type: 'terminate' } })).toThrow();
  });

  it('rejects bad shapes', () => {
    expect(() => mk({ a: { maxVisits: 0, step: 's', type: 'step' } })).toThrow();
    expect(() =>
      mk({ a: { onFailure: { status: 'CANCELLED' }, step: 's', type: 'step' } })
    ).toThrow();
  });

  it('exposes node-id routes as edges and skips the shorthand', () => {
    const s = mk({
      a: { next: 'done', onExhausted: 'done', onFailure: 'done', step: 's', type: 'step' },
      done,
    });
    const a = s.nodes.a as Parameters<typeof nodeEdges>[0];
    expect(nodeEdges(a)).toEqual([
      ['next', 'done'],
      ['onFailure', 'done'],
      ['onExhausted', 'done'],
    ]);
    expect(readNodeEdge(a, 'onFailure')).toBe('done');
    expect(readNodeEdge(setNodeEdge(a, 'onFailure', null), 'onFailure')).toBeUndefined();
    const t = mk({
      a: { onFailure: { status: 'FAILED' }, step: 's', type: 'step' },
    }).nodes.a as Parameters<typeof nodeEdges>[0];
    expect(nodeEdges(t)).toEqual([]);
    expect(readNodeEdge(t, 'onFailure')).toBeUndefined();
  });

  it('reports unknown ids in the new edges', () => {
    expect(() =>
      mk({ a: { next: 'done', onFailure: 'nope', step: 's', type: 'step' }, done })
    ).toThrow(/onFailure.*unknown node 'nope'/);
    expect(() =>
      mk({ a: { maxVisits: 1, onExhausted: 'nope', step: 's', type: 'step' }, done })
    ).toThrow(/onExhausted.*unknown node 'nope'/);
  });
});

describe('validateSpec: new node fields', () => {
  const codes = (nodes: Record<string, unknown>) =>
    validateSpec(mk(nodes)).errors.map((e) => e.code);

  it('rejects storeAs under nodes.', () => {
    expect(
      codes({ a: { next: 'done', step: 's', storeAs: 'nodes.other.output', type: 'step' }, done })
    ).toContain('STORE_AS_NODES_PATH');
    expect(
      codes({ a: { next: 'done', step: 's', storeAs: 'context.x', type: 'step' }, done })
    ).not.toContain('STORE_AS_NODES_PATH');
  });

  it('keeps storeAs under context.', () => {
    for (const bad of ['context', 'request.x', 'workflow.id', 'context..b', 'context.']) {
      expect(
        codes({ a: { next: 'done', step: 's', storeAs: bad, type: 'step' }, done }),
        bad
      ).toContain('STORE_AS_PATH');
    }
    expect(
      codes({ a: { next: 'done', step: 's', storeAs: 'context.a.b', type: 'step' }, done })
    ).not.toContain('STORE_AS_PATH');
  });

  it('rejects an onFailure that points at its own node', () => {
    expect(codes({ a: { next: 'done', onFailure: 'a', step: 's', type: 'step' }, done })).toContain(
      'ON_FAILURE_SELF'
    );
  });

  it('does not count an onExhausted shorthand as a terminal without maxVisits', () => {
    const spec = mk({
      a: { next: 'a', onExhausted: { status: 'FAILED' }, step: 's', type: 'step' },
    });
    expect(validateSpec(spec).errors.map((e) => e.code)).toContain('NO_TERMINAL');
  });

  it('requires onExhausted with maxVisits', () => {
    expect(codes({ a: { maxVisits: 2, next: 'done', step: 's', type: 'step' }, done })).toContain(
      'MAX_VISITS_WITHOUT_ONEXHAUSTED'
    );
  });

  it('treats the terminal shorthand as a terminal exit', () => {
    const r = validateSpec(mk({ a: { onFailure: { status: 'FAILED' }, step: 's', type: 'step' } }));
    expect(r.errors.map((e) => e.code)).not.toContain('NO_TERMINAL');
    expect(r.warnings.map((e) => e.code)).not.toContain('NODE_CANT_TERMINATE');
  });
});

describe('storeAs', () => {
  const s = (onFail?: unknown) =>
    mk({
      a: {
        next: 'done',
        ...(onFail ? { onFail } : {}),
        step: 's',
        storeAs: 'context.saved',
        type: 'step',
      },
      done,
    });

  it('writes the output beside nodes.<id>.output on success', async () => {
    const { d } = harness({ s: [{ v: 1 }] });
    const r = await runSpec(s(), ctx0(), d);
    expect((r.finalContext.context as Record<string, unknown>).saved).toEqual({ v: 1 });
    expect((r.finalContext.nodes as Record<string, { output: unknown }>).a?.output).toEqual({
      v: 1,
    });
  });

  it('writes it on the warn path too', async () => {
    const out = { passed: false, summary: 'no' };
    const { d } = harness({ s: [out] });
    const r = await runSpec(s('warn'), ctx0(), d);
    expect((r.finalContext.context as Record<string, unknown>).saved).toEqual(out);
    expect((r.finalContext.nodes as Record<string, { output: unknown }>).a?.output).toEqual(out);
  });

  it('writes null on the onError continue path', async () => {
    const spec = mk({
      a: { next: 'done', onError: 'continue', step: 's', storeAs: 'context.saved', type: 'step' },
      done,
    });
    const { d } = harness({ s: ['throw'] });
    const r = await runSpec(spec, ctx0(), d);
    expect((r.finalContext.context as Record<string, unknown>).saved).toBeNull();
  });
});

describe('onFailure', () => {
  const routed = (extra: Record<string, unknown> = {}, target: unknown = 'handler') =>
    mk({
      a: { next: 'done', onFailure: target, step: 's', type: 'step', ...extra },
      bad: { status: 'FAILED', type: 'terminate' },
      done,
      handler: { next: 'bad', step: 'h', type: 'step' },
    });

  it('routes a thrown error to the node, recording the failure', async () => {
    const { d, calls, records } = harness({ s: ['throw'] });
    const r = await runSpec(routed(), ctx0(), d);
    expect(calls).toEqual(['s', 'h']);
    expect(r.status).toBe('FAILED');
    expect(records.filter((x) => x.nodeId === 'a')).toEqual([{ nodeId: 'a', status: 'FAILED' }]);
    const a = (r.finalContext.nodes as Record<string, { output: unknown; error: string }>).a;
    expect(a?.output).toBeNull();
    expect(a?.error).toContain('s boom');
  });

  it('routes a gate failure, keeping the gate output', async () => {
    const out = { passed: false, summary: 'nope' };
    const { d, calls } = harness({ s: [out] });
    const r = await runSpec(routed(), ctx0(), d);
    expect(calls).toEqual(['s', 'h']);
    const a = (r.finalContext.nodes as Record<string, { output: unknown; error: string }>).a;
    expect(a?.output).toEqual(out);
    expect(a?.error).toBe('nope');
  });

  it('shorthand ends the run like a terminate node', async () => {
    const { d, calls } = harness({ s: ['throw'] });
    const r = await runSpec(routed({}, { message: 'it broke', status: 'TIMED_OUT' }), ctx0(), d);
    expect(calls).toEqual(['s']);
    expect(r.status).toBe('TIMED_OUT');
    expect(r.result).toEqual({ message: 'it broke' });
  });

  it('shorthand on a gate failure', async () => {
    const { d } = harness({ s: [{ passed: false }] });
    const r = await runSpec(routed({}, { status: 'SKIPPED' }), ctx0(), d);
    expect(r.status).toBe('SKIPPED');
  });

  it('runs onFail retries first, and wins over warn and onError continue', async () => {
    const h = harness({ s: ['throw', 'throw', { ok: 1 }] });
    const ok = await runSpec(routed({ onFail: { retry: 2 } }), ctx0(), h.d);
    expect(h.calls).toEqual(['s', 's', 's']);
    expect(ok.status).toBe('SUCCESS');

    const h2 = harness({ s: ['throw'] });
    const r2 = await runSpec(routed({ onFail: { retry: 1 } }), ctx0(), h2.d);
    expect(h2.calls).toEqual(['s', 's', 'h']);
    expect(r2.status).toBe('FAILED');

    const h3 = harness({ s: ['throw'] });
    await runSpec(routed({ onFail: 'warn' }), ctx0(), h3.d);
    expect(h3.calls).toEqual(['s', 'h']);

    const h4 = harness({ s: ['throw'] });
    await runSpec(routed({ onError: 'continue' }), ctx0(), h4.d);
    expect(h4.calls).toEqual(['s', 'h']);
  });

  it('does not route a cancellation', async () => {
    const h = harness(
      {},
      {
        async dispatchStep() {
          throw new BranchCancelledError();
        },
      }
    );
    await expect(runSpec(routed(), ctx0(), h.d)).rejects.toBeInstanceOf(BranchCancelledError);
    const h2 = harness(
      {},
      {
        async dispatchStep() {
          throw new Error('run cancelled');
        },
        isCancellation: () => true,
      }
    );
    await expect(runSpec(routed({}, { status: 'FAILED' }), ctx0(), h2.d)).rejects.toThrow(
      'run cancelled'
    );
  });

  it('behaves as an ordinary edge inside a fan-out branch', async () => {
    const spec = mk(
      {
        b: { onFailure: 'ok', step: 's', type: 'step' },
        done,
        fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'b', type: 'fanOut' },
        ok: { status: 'SUCCESS', type: 'terminate' },
      },
      'fan'
    );
    const { d, calls } = harness({ s: ['throw'] });
    const r = await runSpec(spec, ctx0(), d);
    expect(calls).toEqual(['s', 's']);
    expect(r.status).toBe('SUCCESS');
  });
});

describe('status hook', () => {
  const spec = mk({
    a: { next: 'b', onFail: { retry: 2 }, status: 'Planning', step: 's', type: 'step' },
    b: { next: 'done', step: 'h', type: 'step' },
    done,
  });

  it('fires once per visit, not per retry', async () => {
    const seen: string[] = [];
    const { d } = harness(
      { s: ['throw', 'throw', {}] },
      {
        async setDomainStatus(st) {
          seen.push(st);
        },
      }
    );
    await runSpec(spec, ctx0(), d);
    expect(seen).toEqual(['Planning']);
  });

  it('fires on each visit of a looped node', async () => {
    const loop = mk({
      a: { next: 'c', status: 'Working', step: 's', type: 'step' },
      c: { expr: 'nodes.a.visits >= 2', onFalse: 'a', onTrue: 'done', type: 'cond' },
      done,
    });
    const seen: string[] = [];
    const loopSpec = mk({
      a: {
        maxVisits: 5,
        next: 'c',
        onExhausted: 'done',
        status: 'Working',
        step: 's',
        type: 'step',
      },
      c: { expr: 'nodes.a.visits >= 2', onFalse: 'a', onTrue: 'done', type: 'cond' },
      done,
    });
    expect(loop.entry).toBe('a');
    const { d } = harness(
      {},
      {
        async setDomainStatus(st) {
          seen.push(st);
        },
      }
    );
    await runSpec(loopSpec, ctx0(), d);
    expect(seen).toEqual(['Working', 'Working']);
  });

  it('is a no-op without the hook, and a failing hook does not fail the run', async () => {
    const h = harness({});
    expect((await runSpec(spec, ctx0(), h.d)).status).toBe('SUCCESS');
    const h2 = harness(
      {},
      {
        async setDomainStatus() {
          throw new Error('db down');
        },
      }
    );
    expect((await runSpec(spec, ctx0(), h2.d)).status).toBe('SUCCESS');
  });
});

describe('maxVisits', () => {
  const loop = (onExhausted: unknown) =>
    mk({
      a: { maxVisits: 3, next: 'a', onExhausted, step: 's', type: 'step' },
      stop: { status: 'FAILED', type: 'terminate' },
    });

  it('routes the (N+1)th entry to onExhausted and exposes the count', async () => {
    const { d, calls } = harness({});
    const r = await runSpec(loop('stop'), ctx0(), d);
    expect(calls).toEqual(['s', 's', 's']);
    expect(r.status).toBe('FAILED');
    expect((r.finalContext.nodes as Record<string, { visits: number }>).a?.visits).toBe(4);
  });

  it('supports the terminal shorthand', async () => {
    const { d, calls } = harness({});
    const r = await runSpec(loop({ message: 'too many', status: 'FAILED' }), ctx0(), d);
    expect(calls.length).toBe(3);
    expect(r.status).toBe('FAILED');
    expect(r.result).toEqual({ message: 'too many' });
  });

  it('counts per fan-out branch', async () => {
    const spec = mk(
      {
        b: { maxVisits: 1, next: 'ok', onExhausted: 'bad', step: 's', type: 'step' },
        bad: { status: 'FAILED', type: 'terminate' },
        done,
        fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'b', type: 'fanOut' },
        ok: { status: 'SUCCESS', type: 'terminate' },
      },
      'fan'
    );
    const { d, calls } = harness({});
    const r = await runSpec(spec, ctx0(), d);
    expect(calls).toEqual(['s', 's']);
    expect(r.status).toBe('SUCCESS');
  });
});
