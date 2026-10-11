import {
  evalBoolean,
  evalExpr,
  hasStep,
  NodeSchema,
  type Node as SpecNode,
} from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { docHref } from '@/components/ui/DocLink';
import { CONTAINER_AUTHORING_RULE } from '@/components/workflow/containerNodes';
import { HELP_LINKS } from './helpLinks';
import { NODE_HELP, nodeHelp } from './nodeHelp';

// Mirrors the node union: a missing entry here is a type error, so a new node type cannot be
// added to the spec without this list (and therefore NODE_HELP) being updated.
const ALL_TYPES: Record<SpecNode['type'], true> = {
  agent: true,
  cond: true,
  containerStep: true,
  eval: true,
  fanOut: true,
  humanApproval: true,
  humanDecision: true,
  humanInput: true,
  humanReview: true,
  mcp: true,
  set: true,
  shell: true,
  signal: true,
  step: true,
  terminate: true,
};
const TYPES = Object.keys(ALL_TYPES) as SpecNode['type'][];

describe('NODE_HELP', () => {
  it('has an entry for every node type in the spec, and no others', () => {
    // The spec's own discriminated union is the source of truth for the list of types.
    const specTypes = NodeSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(NODE_HELP).sort()).toEqual(specTypes);
    expect([...TYPES].sort()).toEqual(specTypes);
  });

  it.each(TYPES)('%s: every section is filled in', (type) => {
    const h = nodeHelp(type);
    for (const text of [h.what, h.when, h.gotcha]) {
      expect(text.trim().length).toBeGreaterThan(20);
    }
  });

  it.each(TYPES)('%s: the example is a valid node of that type', (type) => {
    const parsed = NodeSchema.safeParse(nodeHelp(type).example);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.type).toBe(type);
  });

  it.each(TYPES)('%s: the docs link is one the link registry knows', (type) => {
    const { doc } = nodeHelp(type);
    const known = Object.values(HELP_LINKS).some(
      (l) =>
        l.slug === doc.slug &&
        (('anchor' in l ? l.anchor : undefined) as string | undefined) === doc.anchor
    );
    expect(known).toBe(true);
    expect(docHref(doc.slug, doc.anchor)).toMatch(/^\/docs\//);
  });

  it('uses a registered step in its step example', () => {
    const example = nodeHelp('step').example as { step: string };
    expect(hasStep(example.step)).toBe(true);
  });

  it('the cond example expression evaluates to the right value, including with keys absent', () => {
    const { expressionExample, example } = nodeHelp('cond');
    expect(expressionExample).toBe((example as { expr: string }).expr);
    const run = (ctx: Record<string, unknown>) => evalBoolean(expressionExample as string, ctx);
    const reviewed = (approved: boolean) => ({ review: { output: { approved } } });
    expect(run({ context: { attempts: 1 }, nodes: reviewed(false) })).toBe(true);
    expect(run({ context: { attempts: 3 }, nodes: reviewed(false) })).toBe(false);
    expect(run({ context: { attempts: 1 }, nodes: reviewed(true) })).toBe(false);
    // First use: no counter yet, and no review output yet.
    expect(run({ context: {} })).toBe(true);
    expect(run({ context: {}, nodes: {} })).toBe(true);
  });

  it('the cond gotcha is true: ordering needs numbers, == is strict, ?? guards a missing value', () => {
    expect(() => evalBoolean('a < 3', { a: '2' })).toThrow();
    expect(evalBoolean('a == 2', { a: '2' })).toBe(false);
    // The recommended guard works with the key present, null, and entirely absent ...
    const guard = '(a.count ?? 0) > 0';
    expect(evalBoolean(guard, { a: { count: 2 } })).toBe(true);
    expect(evalBoolean(guard, { a: { count: 0 } })).toBe(false);
    expect(evalBoolean(guard, { a: null })).toBe(false);
    expect(evalBoolean(guard, {})).toBe(false);
    // ... while the null-check the help warns against does not, when a is absent.
    expect(() => evalBoolean('a != null && a.count > 0', {})).toThrow();
    expect(nodeHelp('cond').gotcha).toContain(guard);
    // And what it says is unsupported really is.
    expect(() => evalBoolean('len(a) > 0', { a: [1] })).toThrow();
  });

  it('the set example expression evaluates to the next counter value, from an empty context', () => {
    const example = nodeHelp('set').example as { values: Record<string, { expr: string }> };
    const expr = example.values['context.attempts']?.expr as string;
    expect(evalExpr(expr, { context: {} })).toBe(1);
    expect(evalExpr(expr, { context: { attempts: 2 } })).toBe(3);
  });

  it('the eval example is a standalone assert, and the gotcha names the real blocking rule', () => {
    const example = nodeHelp('eval').example as { scorers: Array<{ kind: string; expr?: string }> };
    expect(example.scorers.map((s) => s.kind)).toEqual(['assert']);
    const expr = String(example.scorers[0]?.expr);
    expect(evalBoolean(expr.replace(/\$\./g, ''), { approved: true })).toBe(true);
    expect(evalBoolean(expr.replace(/\$\./g, ''), { approved: false })).toBe(false);
    const { gotcha } = nodeHelp('eval');
    expect(gotcha).toContain('judgeAdvisory to false, which makes only the judge blocking');
    expect(gotcha).toMatch(/policy and pii/);
  });

  it('the fanOut gotcha says branches do not see parent node outputs', () => {
    expect(nodeHelp('fanOut').gotcha).toMatch(
      /nodes\.<id>\.output values are not visible inside a branch/
    );
    expect(nodeHelp('fanOut').gotcha).toContain('Index');
  });

  it('the container nodes state the real authoring rule', () => {
    for (const type of ['shell', 'containerStep'] as const) {
      expect(nodeHelp(type).gotcha).toContain(CONTAINER_AUTHORING_RULE);
    }
    expect(CONTAINER_AUTHORING_RULE).toMatch(/platform lead/);
  });

  it('the signal gotcha is true: a duration is accepted, a vague word is not', () => {
    const base = nodeHelp('signal').example;
    expect(NodeSchema.safeParse({ ...base, timeout: '30m' }).success).toBe(true);
    expect(NodeSchema.safeParse({ ...base, timeout: 'soon' }).success).toBe(false);
  });
});
