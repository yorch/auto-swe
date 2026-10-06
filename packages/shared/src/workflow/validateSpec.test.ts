import { describe, expect, it } from 'vitest';
import { BUILTIN_SHELL_IMAGES } from './shellImageAllowlist.js';
import { parseWorkflowSpec } from './spec.js';
import { BUILTIN_TEMPLATES } from './templates/index.js';
import { validateSpec } from './validateSpec.js';

function spec(nodes: Record<string, unknown>, entry = 'a') {
  return parseWorkflowSpec({ entry, name: 'test', nodes, schemaVersion: 1 });
}

describe('validateSpec fan-out closure', () => {
  const fan = (branchNext?: string) =>
    spec(
      {
        branch: {
          step: 'executeImplementation',
          type: 'step',
          ...(branchNext && { next: branchNext }),
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          over: { literal: [1, 2] },
          subgraph: 'branch',
          type: 'fanOut',
        },
      },
      'fan'
    );

  it('is quiet for a branch that ends on its own', () => {
    const codes = validateSpec(fan()).warnings.map((w) => w.code);
    expect(codes).not.toContain('FANOUT_LEAK');
    expect(codes).not.toContain('TERMINAL_IN_SUBGRAPH_ONLY');
  });

  it('warns when a branch continues into the join node', () => {
    const w = validateSpec(fan('done')).warnings.find((x) => x.code === 'FANOUT_LEAK');
    expect(w?.nodeId).toBe('fan');
  });

  it('warns when the only terminate is inside a branch', () => {
    const report = validateSpec(
      spec(
        {
          after: { type: 'set', values: { 'context.x': { literal: 1 } } },
          branch: { next: 'end', step: 'executeImplementation', type: 'step' },
          end: { status: 'SUCCESS', type: 'terminate' },
          fan: { join: 'after', over: { literal: [1] }, subgraph: 'branch', type: 'fanOut' },
        },
        'fan'
      )
    );
    expect(report.warnings.map((w) => w.code)).toContain('TERMINAL_IN_SUBGRAPH_ONLY');
  });
});

describe('validateSpec IGNORED_FIELD', () => {
  it('warns on retry/timeout fields the interpreter never reads, and still parses them', () => {
    const report = validateSpec(
      spec({
        a: {
          heartbeatTimeout: '5m',
          next: 'done',
          retry: { maximumAttempts: 3 },
          startToCloseTimeout: '30m',
          step: 'executeImplementation',
          type: 'step',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(report.errors).toEqual([]);
    const ignored = report.warnings.filter((w) => w.code === 'IGNORED_FIELD');
    expect(ignored.map((w) => w.field).sort()).toEqual([
      'heartbeatTimeout',
      'retry',
      'startToCloseTimeout',
    ]);
  });
});

describe('validateSpec', () => {
  it('passes a clean linear spec', () => {
    const r = validateSpec(
      spec({
        a: { next: 'done', step: 'runLint', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.errors).toEqual([]);
  });

  it('flags an unparseable cond expression (=== is not supported)', () => {
    const r = validateSpec(
      spec({
        a: { expr: 'nodes.x.output.ok === true', onFalse: 'done', onTrue: 'done', type: 'cond' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.errors.some((e) => e.code === 'EXPR_SYNTAX' && e.nodeId === 'a')).toBe(true);
  });

  it('accepts a valid cond expression', () => {
    const r = validateSpec(
      spec({
        a: { expr: 'nodes.x.output.ok == true', onFalse: 'done', onTrue: 'done', type: 'cond' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.errors.filter((e) => e.code === 'EXPR_SYNTAX')).toEqual([]);
  });

  it('warns (does not error) on a binding that reads from an unknown node', () => {
    const r = validateSpec(
      spec({
        a: {
          inputs: { x: { from: 'nodes.ghost.output.value' } },
          next: 'done',
          step: 'runLint',
          type: 'step',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.warnings.some((w) => w.code === 'UNKNOWN_NODE_REF')).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a from-path under a node id that itself contains a dot', () => {
    const r = validateSpec(
      spec({
        a: {
          inputs: { x: { from: 'nodes.my.svc.output.value' } },
          next: 'done',
          step: 'runLint',
          type: 'step',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
        'my.svc': { next: 'a', step: 'runLint', type: 'step' },
      })
    );
    expect(r.warnings.some((w) => w.code === 'UNKNOWN_NODE_REF')).toBe(false);
  });

  it('does NOT flag valid relational/arithmetic expressions over context paths', () => {
    // Regression: evaluating `count >= 3` against an empty context throws a
    // runtime type error; that must NOT be reported as a syntax error.
    for (const expr of [
      'context.retries >= 3',
      'nodes.x.output.n + 1 > 5',
      '-nodes.x.output.n < 0',
      "nodes.x.output.status == 'done'",
    ]) {
      const r = validateSpec(
        spec({
          a: { expr, onFalse: 'done', onTrue: 'done', type: 'cond' },
          done: { status: 'SUCCESS', type: 'terminate' },
        })
      );
      expect(r.errors.filter((e) => e.code === 'EXPR_SYNTAX')).toEqual([]);
    }
  });

  it('allows request/context binding roots', () => {
    const r = validateSpec(
      spec({
        a: {
          inputs: { x: { from: 'request.description' } },
          next: 'done',
          step: 'runLint',
          type: 'step',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.errors).toEqual([]);
  });

  it('warns on an unreachable node', () => {
    const r = validateSpec(
      spec({
        a: { next: 'done', step: 'runLint', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
        orphan: { next: 'done', step: 'runLint', type: 'step' },
      })
    );
    expect(r.warnings.some((w) => w.code === 'UNREACHABLE' && w.nodeId === 'orphan')).toBe(true);
  });

  it('errors when no terminate is reachable', () => {
    // a → b → a loop, no terminate anywhere.
    const r = validateSpec(
      spec({
        a: { next: 'b', step: 'runLint', type: 'step' },
        b: { next: 'a', step: 'runLint', type: 'step' },
      })
    );
    expect(r.errors.some((e) => e.code === 'NO_TERMINAL')).toBe(true);
  });

  it('warns when a reachable node cannot reach any terminate', () => {
    // entry can terminate, but a side loop cannot.
    const r = validateSpec(
      spec(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          gate: { expr: 'true', onFalse: 'loop', onTrue: 'done', type: 'cond' },
          loop: { next: 'loop2', step: 'runLint', type: 'step' },
          loop2: { next: 'loop', step: 'runLint', type: 'step' },
        },
        'gate'
      )
    );
    expect(r.warnings.some((w) => w.code === 'NODE_CANT_TERMINATE')).toBe(true);
  });

  it('every built-in template passes validation with zero errors', () => {
    // Guard against the false-positive class that flagged real workflows
    // (e.g. retry-counter conds like `context.ciRetries >= 3`).
    for (const tmpl of BUILTIN_TEMPLATES) {
      const r = validateSpec(tmpl.spec);
      expect(r.errors, `${tmpl.name}: ${JSON.stringify(r.errors)}`).toEqual([]);
    }
  });

  it('every built-in template picks a shell image from the built-in allowlist', () => {
    // `validateSpec` deliberately leaves image checks to run time (see its
    // header): the effective allowlist is per-team, so a static validator
    // cannot decide it. That is right for user specs and wrong for seeded
    // ones — a built-in template ships to every team, so the only allowlist it
    // can rely on is the built-in set, and that IS decidable here.
    //
    // Nothing checked it before, and MIGRATION_SPEC shipped pinned to
    // `node:24-slim`. The allowlist is enforced when the container launches,
    // so the seeded template was rejected mid-run, every run — while the
    // "every built-in template passes validation" test above stayed green.
    const offenders: string[] = [];
    for (const tmpl of BUILTIN_TEMPLATES) {
      for (const [nodeId, node] of Object.entries(tmpl.spec.nodes)) {
        if (node.type !== 'shell' && node.type !== 'containerStep') {
          continue;
        }
        if (!BUILTIN_SHELL_IMAGES.includes(node.image)) {
          offenders.push(`${tmpl.name}.${nodeId} → ${node.image}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('warns on an unknown step name', () => {
    const r = validateSpec(
      spec({
        a: { next: 'done', step: 'notARealStep', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.warnings.some((w) => w.code === 'UNKNOWN_STEP')).toBe(true);
  });
});

describe('validateSpec reserved write-path segments', () => {
  const codesFor = (nodes: Record<string, unknown>, entry: string) =>
    validateSpec(spec(nodes, entry)).errors.filter((e) => e.code === 'RESERVED_PATH_SEGMENT');

  it('flags a set key, a storeAs, a fan-out export and a node id that write through a reserved segment', () => {
    const errors = codesFor(
      {
        constructor: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          exports: ['context.__proto__.x'],
          join: 'constructor',
          over: { literal: [1] },
          subgraph: 'set',
          type: 'fanOut',
        },
        set: { next: 'wait', type: 'set', values: { 'context.prototype.y': { literal: 1 } } },
        wait: {
          name: 's',
          onReceive: 'constructor',
          onTimeout: 'constructor',
          storeAs: 'context.__proto__',
          timeout: '1h',
          type: 'signal',
        },
      },
      'fan'
    );
    expect(errors.map((e) => `${e.nodeId}:${e.field}`).sort()).toEqual([
      'constructor:id',
      'fan:exports',
      'set:values.context.prototype.y',
      'wait:storeAs',
    ]);
  });

  it('is quiet for ordinary paths', () => {
    expect(
      codesFor(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          set: { next: 'done', type: 'set', values: { 'context.plan.status': { literal: 1 } } },
        },
        'set'
      )
    ).toEqual([]);
  });
});
