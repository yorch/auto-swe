import { describe, expect, it } from 'vitest';
import { checkExprSyntax, evalBoolean, evalExpr, lookupPath, resolveBinding } from './expr.js';

describe('checkExprSyntax', () => {
  it('flags lexical/structural syntax errors', () => {
    expect(checkExprSyntax('a === b')).toMatch(/unexpected/i); // === is not valid
    expect(checkExprSyntax('foo(1)')).not.toBeNull(); // method/function call
    expect(checkExprSyntax('a &&')).not.toBeNull(); // dangling operator
  });

  it('flags malformed PATH syntax (context-independent, deterministic crash)', () => {
    // These throw in tokenizePath regardless of context, so they must be reported
    // as syntax errors — not silently ignored like runtime type errors.
    expect(checkExprSyntax('nodes.foo[')).toMatch(/unterminated \[/);
    expect(checkExprSyntax('nodes.foo[bar]')).toMatch(/invalid index/);
  });

  it('does NOT flag valid expressions that merely resolve to undefined at eval', () => {
    // The whole point of the parse-only check: a relational/arithmetic expr over a
    // context path is well-formed even though it throws against an empty context.
    expect(checkExprSyntax('count >= 3')).toBeNull();
    expect(checkExprSyntax('a.b.c == true')).toBeNull();
    expect(checkExprSyntax('nodes.impl.output.n + 1 > 2')).toBeNull();
  });
});

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

  it('rejects malformed number literals like 1.2.3', () => {
    expect(() => evalExpr('1.2.3', ctx)).toThrow(/invalid number literal/);
    expect(() => evalExpr('1..2', ctx)).toThrow(/invalid number literal/);
  });

  it('throws a clear error when arithmetic gets a non-number', () => {
    const c = { a: 'hello', b: null, c: undefined };
    expect(() => evalExpr('a + 1', c)).toThrow(/operator '\+' requires a number/);
    expect(() => evalExpr('b - 1', c)).toThrow(/requires a number, got null/);
    expect(() => evalExpr('c * 2', c)).toThrow(/requires a number, got undefined/);
  });

  it('throws a clear error when ordered comparison gets a non-number', () => {
    expect(() => evalExpr("'foo' < 1", {})).toThrow(/operator '<' requires a number/);
    expect(() => evalExpr('missing >= 3', {})).toThrow(/requires a number, got undefined/);
  });

  it('still permits === / !== across any types (identity, no coercion)', () => {
    expect(evalExpr("'a' == 'a'", {})).toBe(true);
    expect(evalExpr("'a' != 1", {})).toBe(true);
    expect(evalExpr('null == null', {})).toBe(true);
  });

  it('rejects unary minus on non-numbers', () => {
    expect(() => evalExpr('-name', { name: 'foo' })).toThrow(
      /operator 'unary -' requires a number/
    );
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
