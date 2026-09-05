/**
 * Safe expression evaluator for workflow conditionals and bindings.
 *
 * Supports only:
 *   - path lookups:   foo.bar[0].baz
 *   - literals:       numbers, strings, true, false, null
 *   - arithmetic:     +  -  *  /   (numbers only; no string concat side effects beyond +)
 *   - comparisons:    ==  !=  <  <=  >  >=
 *   - boolean logic:  &&  ||  !
 *   - nullish/default: a ?? b
 *   - parentheses for grouping
 *
 * Intentionally NO function calls, NO assignment, NO property access via
 * expressions, NO `eval`. Strict to keep workflow templates deterministic
 * and safe.
 */

import type { Binding } from './spec.js';

export type Context = Record<string, unknown>;

/**
 * Path segments that must never be read or written through: a spec is
 * team-authored JSON, and walking `constructor.prototype` in a lookup — or
 * writing through `__proto__` — turns a bad binding into prototype pollution of
 * the workflow context. Shared by `lookupPath` (reads) and the interpreter's
 * `setPath` (writes).
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

// ── Public API ────────────────────────────────────────────────────────────

export function resolveBinding(binding: Binding, ctx: Context): unknown {
  if ('literal' in binding) {
    return binding.literal;
  }
  if ('from' in binding) {
    const v = lookupPath(ctx, binding.from);
    return v === undefined ? binding.default : v;
  }
  if ('expr' in binding) {
    return evalExpr(binding.expr, ctx);
  }
  throw new Error('binding must have one of: literal, from, expr');
}

export function lookupPath(ctx: Context, path: string): unknown {
  const tokens = tokenizePath(path);
  let current: unknown = ctx;
  for (const tok of tokens) {
    if (current == null) {
      return undefined;
    }
    if (typeof tok === 'number') {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[tok];
    } else {
      if (typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[tok];
    }
  }
  return current;
}

/**
 * Lexical / structural error in an expression (e.g. `===`, a method call, an
 * unterminated string, a missing `)`). Distinct from the runtime type errors
 * the operators throw (e.g. `>` on a `undefined` operand) so a SYNTAX-only check
 * can ignore the latter — see {@link checkExprSyntax}.
 */
export class ExprSyntaxError extends Error {}

export function evalExpr(expr: string, ctx: Context): unknown {
  const tokens = tokenizeExpr(expr);
  const parser = new Parser(tokens, ctx);
  const result = parser.parseOr();
  parser.expectEnd();
  return result;
}

export function evalBoolean(expr: string, ctx: Context): boolean {
  const v = evalExpr(expr, ctx);
  return Boolean(v);
}

/**
 * Validate an expression's SYNTAX without caring whether it resolves at runtime.
 * Returns the syntax-error message, or `null` if the expression is well-formed.
 *
 * It evaluates against an empty context and treats only {@link ExprSyntaxError}
 * (tokenizer/parser failures) as a problem — runtime type errors raised by the
 * operators on absent/undefined operands (e.g. `count >= 3` against `{}`) are
 * NOT syntax errors and must not be reported, or every comparison/arithmetic
 * over a context path would be a false positive.
 */
export function checkExprSyntax(expr: string): string | null {
  try {
    evalExpr(expr, {});
    return null;
  } catch (err) {
    if (err instanceof ExprSyntaxError) {
      return err.message;
    }
    return null;
  }
}

// ── Path tokenization ─────────────────────────────────────────────────────

function tokenizePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      i++;
      continue;
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) {
        // Structural path-syntax error (context-independent) → a syntax error so
        // checkExprSyntax flags it, not just a runtime throw.
        throw new ExprSyntaxError(`unterminated [ in path: ${path}`);
      }
      const idx = path.slice(i + 1, end).trim();
      if (/^-?\d+$/.test(idx)) {
        out.push(Number.parseInt(idx, 10));
      } else if (
        (idx.startsWith('"') && idx.endsWith('"')) ||
        (idx.startsWith("'") && idx.endsWith("'"))
      ) {
        out.push(idx.slice(1, -1));
      } else {
        throw new ExprSyntaxError(`invalid index '${idx}' in path: ${path}`);
      }
      i = end + 1;
      continue;
    }
    // identifier
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') {
      j++;
    }
    const id = path.slice(i, j);
    if (!id) {
      throw new ExprSyntaxError(`empty segment in path: ${path}`);
    }
    out.push(id);
    i = j;
  }
  for (const seg of out) {
    if (typeof seg === 'string' && RESERVED_SEGMENTS.has(seg)) {
      // A syntax error rather than a runtime one so checkExprSyntax rejects the
      // spec at save time, not on the first run that evaluates it.
      throw new ExprSyntaxError(`reserved segment '${seg}' in path: ${path}`);
    }
  }
  return out;
}

// ── Expression tokenization + parsing ─────────────────────────────────────

type Tok =
  | { kind: 'num'; val: number }
  | { kind: 'str'; val: string }
  | { kind: 'bool'; val: boolean }
  | { kind: 'null' }
  | { kind: 'path'; val: string }
  | {
      kind: 'op';
      val:
        | '=='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | '&&'
        | '||'
        | '!'
        | '??'
        | '+'
        | '-'
        | '*'
        | '/'
        | '('
        | ')';
    };

function tokenizeExpr(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const len = input.length;
  while (i < len) {
    const c = input[i];
    if (c === undefined) {
      break;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let val = '';
      while (j < len && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < len) {
          const next = input[j + 1] as string;
          val += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          val += input[j];
          j++;
        }
      }
      if (j >= len) {
        throw new ExprSyntaxError(`unterminated string in expr: ${input}`);
      }
      tokens.push({ kind: 'str', val });
      i = j + 1;
      continue;
    }
    // number — accept at most one decimal point so malformed literals like
    // `1.2.3` fail fast instead of being silently truncated by parseFloat.
    if ((c >= '0' && c <= '9') || (c === '-' && /\d/.test(input[i + 1] ?? ''))) {
      let j = i + 1;
      let seenDot = false;
      while (j < len) {
        const ch = input[j] as string;
        if (ch >= '0' && ch <= '9') {
          j++;
        } else if (ch === '.') {
          if (seenDot) {
            throw new ExprSyntaxError(`invalid number literal at position ${i} in expr: ${input}`);
          }
          seenDot = true;
          j++;
        } else {
          break;
        }
      }
      const literal = input.slice(i, j);
      if (literal === '.' || literal === '-' || literal === '-.') {
        throw new ExprSyntaxError(`invalid number literal '${literal}' in expr: ${input}`);
      }
      tokens.push({ kind: 'num', val: Number.parseFloat(literal) });
      i = j;
      continue;
    }
    // operators (2-char first)
    const two = input.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||' ||
      two === '??'
    ) {
      tokens.push({ kind: 'op', val: two });
      i += 2;
      continue;
    }
    if (
      c === '<' ||
      c === '>' ||
      c === '!' ||
      c === '(' ||
      c === ')' ||
      c === '+' ||
      c === '-' ||
      c === '*' ||
      c === '/'
    ) {
      tokens.push({ kind: 'op', val: c as '<' | '>' | '!' | '(' | ')' | '+' | '-' | '*' | '/' });
      i++;
      continue;
    }
    // identifier / path / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$.[\]'"]/.test(input[j] as string)) {
        j++;
      }
      const id = input.slice(i, j);
      if (id === 'true') {
        tokens.push({ kind: 'bool', val: true });
      } else if (id === 'false') {
        tokens.push({ kind: 'bool', val: false });
      } else if (id === 'null') {
        tokens.push({ kind: 'null' });
      } else {
        tokens.push({ kind: 'path', val: id });
      }
      i = j;
      continue;
    }
    throw new ExprSyntaxError(`unexpected character '${c}' at position ${i} in expr: ${input}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly ctx: Context
  ) {}

  expectEnd(): void {
    if (this.pos < this.toks.length) {
      throw new ExprSyntaxError(`unexpected trailing tokens at position ${this.pos}`);
    }
  }

  parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOp('||')) {
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  parseAnd(): unknown {
    let left = this.parseCoalesce();
    while (this.matchOp('&&')) {
      const right = this.parseCoalesce();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  parseCoalesce(): unknown {
    let left = this.parseCompare();
    while (this.matchOp('??')) {
      const right = this.parseCompare();
      left = left == null ? right : left;
    }
    return left;
  }

  parseCompare(): unknown {
    const left = this.parseAdd();
    const op = this.peekOp();
    if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      this.pos++;
      const right = this.parseAdd();
      return compare(op, left, right);
    }
    return left;
  }

  parseAdd(): unknown {
    let left = this.parseMul();
    while (true) {
      if (this.matchOp('+')) {
        const right = this.parseMul();
        left = requireNumber(left, '+') + requireNumber(right, '+');
      } else if (this.matchOp('-')) {
        const right = this.parseMul();
        left = requireNumber(left, '-') - requireNumber(right, '-');
      } else {
        break;
      }
    }
    return left;
  }

  parseMul(): unknown {
    let left = this.parseUnary();
    while (true) {
      if (this.matchOp('*')) {
        const right = this.parseUnary();
        left = requireNumber(left, '*') * requireNumber(right, '*');
      } else if (this.matchOp('/')) {
        const right = this.parseUnary();
        left = requireNumber(left, '/') / requireNumber(right, '/');
      } else {
        break;
      }
    }
    return left;
  }

  parseUnary(): unknown {
    if (this.matchOp('!')) {
      const v = this.parseUnary();
      return !v;
    }
    if (this.matchOp('-')) {
      const v = this.parseUnary();
      return -requireNumber(v, 'unary -');
    }
    return this.parsePrimary();
  }

  parsePrimary(): unknown {
    const tok = this.toks[this.pos];
    if (!tok) {
      throw new ExprSyntaxError('unexpected end of expression');
    }
    if (tok.kind === 'op' && tok.val === '(') {
      this.pos++;
      const v = this.parseOr();
      if (!this.matchOp(')')) {
        throw new ExprSyntaxError('expected )');
      }
      return v;
    }
    this.pos++;
    switch (tok.kind) {
      case 'num':
      case 'str':
      case 'bool':
        return tok.val;
      case 'null':
        return null;
      case 'path':
        return lookupPath(this.ctx, tok.val);
      default:
        throw new ExprSyntaxError(`unexpected operator ${tok.val}`);
    }
  }

  private peekOp(): string | null {
    const tok = this.toks[this.pos];
    return tok && tok.kind === 'op' ? tok.val : null;
  }
  private matchOp(op: string): boolean {
    if (this.peekOp() === op) {
      this.pos++;
      return true;
    }
    return false;
  }
}

function requireNumber(v: unknown, op: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`operator '${op}' requires a number, got ${describeOperand(v)}`);
  }
  return v;
}

export function describeOperand(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (v === undefined) {
    return 'undefined';
  }
  if (Array.isArray(v)) {
    return `array(${v.length})`;
  }
  // Type only — never the content. Operands come from step outputs and request
  // payloads, and these messages land in step rows, logs and the run page.
  return `${typeof v}`;
}

function compare(op: '==' | '!=' | '<' | '<=' | '>' | '>=', l: unknown, r: unknown): boolean {
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '<':
      return requireNumber(l, '<') < requireNumber(r, '<');
    case '<=':
      return requireNumber(l, '<=') <= requireNumber(r, '<=');
    case '>':
      return requireNumber(l, '>') > requireNumber(r, '>');
    case '>=':
      return requireNumber(l, '>=') >= requireNumber(r, '>=');
  }
}
