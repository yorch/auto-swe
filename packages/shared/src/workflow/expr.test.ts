import { describe, expect, it } from 'vitest';
import { evalBoolean, evalExpr, lookupPath, resolveBinding } from './expr.js';

describe('lookupPath', () => {
  it('reads nested fields and array indices', () => {
    const ctx = { nodes: { impl: { output: { files: [{ path: 'a.ts' }, { path: 'b.ts' }] } } } };
    expect(lookupPath(ctx, 'nodes.impl.output.files[1].path')).toBe('b.ts');
  });

  it('returns undefined for missing paths', () => {
    expect(lookupPath({}, 'a.b.c')).toBeUndefined();
  });

  it('supports quoted keys with dots', () => {
    expect(lookupPath({ foo: { 'a.b': 1 } }, "foo['a.b']")).toBe(1);
  });
});

describe('evalExpr', () => {
  const ctx = {
    counters: { ci: 0, review: 2 },
    nodes: { review: { output: { approved: false } } },
  };

  it('evaluates comparisons', () => {
    expect(evalExpr('counters.review >= 3', ctx)).toBe(false);
    expect(evalExpr('counters.review == 2', ctx)).toBe(true);
    expect(evalExpr('counters.ci != 1', ctx)).toBe(true);
  });

  it('evaluates boolean logic with precedence', () => {
    expect(evalExpr('counters.ci == 0 && counters.review < 3', ctx)).toBe(true);
    expect(evalExpr('counters.ci > 5 || counters.review == 2', ctx)).toBe(true);
    expect(evalExpr('!nodes.review.output.approved', ctx)).toBe(true);
  });

  it('honors parentheses', () => {
    expect(
      evalExpr('(counters.ci == 0 || counters.review == 0) && counters.review == 2', ctx)
    ).toBe(true);
  });

  it('supports nullish coalescing', () => {
    expect(evalExpr('counters.missing ?? 7', ctx)).toBe(7);
    expect(evalExpr('counters.ci ?? 7', ctx)).toBe(0);
  });

  it('supports arithmetic', () => {
    expect(evalExpr('counters.review + 1', ctx)).toBe(3);
    expect(evalExpr('counters.review * 2 - 1', ctx)).toBe(3);
    expect(evalExpr('(counters.review + 1) * 2', ctx)).toBe(6);
    expect(evalExpr('-counters.review', ctx)).toBe(-2);
  });

  it('rejects function calls', () => {
    expect(() => evalExpr('foo()', ctx)).toThrow();
  });

  it('evalBoolean coerces to boolean', () => {
    expect(evalBoolean('counters.ci', ctx)).toBe(false);
    expect(evalBoolean('counters.review', ctx)).toBe(true);
  });
});

describe('resolveBinding', () => {
  const ctx = { a: { b: 1 } };

  it('resolves literal bindings', () => {
    expect(resolveBinding({ literal: 'hello' }, ctx)).toBe('hello');
  });

  it('resolves from bindings with default', () => {
    expect(resolveBinding({ from: 'a.b' }, ctx)).toBe(1);
    expect(resolveBinding({ default: 42, from: 'a.missing' }, ctx)).toBe(42);
  });

  it('resolves expression bindings', () => {
    expect(resolveBinding({ expr: 'a.b == 1' }, ctx)).toBe(true);
  });
});
