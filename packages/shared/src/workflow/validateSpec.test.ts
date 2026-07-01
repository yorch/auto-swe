import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from './spec.js';
import { BUILTIN_TEMPLATES } from './templates/index.js';
import { validateSpec } from './validateSpec.js';

function spec(nodes: Record<string, unknown>, entry = 'a') {
  return parseWorkflowSpec({ entry, name: 'test', nodes, schemaVersion: 1 });
}

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
