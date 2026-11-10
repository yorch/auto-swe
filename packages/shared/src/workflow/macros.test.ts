import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtinTemplates.js';
import {
  collectUseProblems,
  detachUse,
  expandUse,
  findUseProblems,
  getMacro,
  isValidUseId,
  MACROS,
  type MacroUse,
  MacroUseError,
  materializeUses,
  reexpandUse,
  useEntry,
} from './macros.js';
import {
  findInvalidPresentation,
  type Node,
  NodeSchema,
  parseWorkflowSpec,
  SPEC_SCHEMA_VERSION,
  type WorkflowSpec,
  WorkflowSpecSchema,
} from './spec.js';
import {
  ciLoop,
  ciWaitEntry,
  type NodeMap,
  openPullRequest,
  reviewLoop,
  validatePhase,
  validatePhaseEntry,
} from './templates/authoring/index.js';
import { validateSpec } from './validateSpec.js';

/** JSON with sorted keys: the form a stored spec is compared in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]])
        )
      : v
  );
}

const tagAll = (nodes: NodeMap, use: string): NodeMap =>
  Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { ...n, use }]));

/** Each macro, a representative argument set, the helper call it must equal and its entry. */
const CASES: Array<{
  ref: string;
  args: Record<string, unknown>;
  helper: () => NodeMap;
  entry: string;
}> = [
  {
    args: { fix: false, passed: 'done' },
    entry: 'waitForCI',
    helper: () => ciLoop({ fix: false, passed: 'done' }),
    ref: 'ciLoop@1',
  },
  {
    args: {
      exhausted: 'lessonCIFailed',
      fix: { handoff: { rereview: 'review' } },
      passed: 'waitForHumanMerge',
      wait: 'pollOrSignal',
    },
    entry: 'loadCiWaitConfig',
    helper: () =>
      ciLoop({
        exhausted: 'lessonCIFailed',
        fix: { handoff: { rereview: 'review' } },
        passed: 'waitForHumanMerge',
        wait: 'pollOrSignal',
      }),
    ref: 'ciLoop@1',
  },
  {
    args: {
      fix: {
        handoff: { repush: 'pushFix', status: 'AWAITING_CI' },
        limit: 'request.payload.maxFixes ?? 2',
        retryIfUnchanged: true,
      },
      passed: 'done',
    },
    entry: 'waitForCI',
    helper: () =>
      ciLoop({
        fix: {
          handoff: { repush: 'pushFix', status: 'AWAITING_CI' },
          limit: 'request.payload.maxFixes ?? 2',
          retryIfUnchanged: true,
        },
        passed: 'done',
      }),
    ref: 'ciLoop@1',
  },
  {
    args: { afterFix: 'clearCiResult', approved: 'openPR', exhausted: 'lessonReviewFailed' },
    entry: 'review',
    helper: () =>
      reviewLoop({
        afterFix: 'clearCiResult',
        approved: 'openPR',
        exhausted: 'lessonReviewFailed',
      }),
    ref: 'reviewLoop@1',
  },
  {
    args: { approved: 'done', fixConfig: { allowedPaths: ['docs/**'] }, limit: 4 },
    entry: 'review',
    helper: () =>
      reviewLoop({ approved: 'done', fixConfig: { allowedPaths: ['docs/**'] }, limit: 4 }),
    ref: 'reviewLoop@1',
  },
  {
    args: { next: 'implement' },
    entry: 'validate',
    helper: () => validatePhase({ next: 'implement' }),
    ref: 'validatePhase@1',
  },
  {
    args: { next: 'implement', stopIfNotActionable: true, ticketContext: true },
    entry: 'gatherTicket',
    helper: () =>
      validatePhase({ next: 'implement', stopIfNotActionable: true, ticketContext: true }),
    ref: 'validatePhase@1',
  },
  {
    args: { next: 'waitForCI' },
    entry: 'openPR',
    helper: () => openPullRequest({ next: 'waitForCI' }),
    ref: 'openPullRequest@1',
  },
  {
    args: { draft: true, next: 'waitForCI', resetCiRetries: true, status: 'AWAITING_CI' },
    entry: 'openPR',
    helper: () =>
      openPullRequest({
        draft: true,
        next: 'waitForCI',
        resetCiRetries: true,
        status: 'AWAITING_CI',
      }),
    ref: 'openPullRequest@1',
  },
];

/**
 * A small runnable spec around one use, before materialisation: a `start` node routing
 * into the use's entry and a `done` terminate. Every argument case routes out to `done`.
 */
interface TestSpec {
  description: string;
  entry: string;
  name: string;
  nodes: Record<string, Node>;
  schemaVersion: typeof SPEC_SCHEMA_VERSION;
  uses?: Record<string, MacroUse>;
}

function specWith(useId: string, use: MacroUse, extra: Record<string, unknown> = {}): TestSpec {
  return {
    description: '',
    entry: 'start',
    name: 'macro test',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      start: { next: useEntry(use), type: 'set', values: {} },
      ...(extra as Record<string, Node>),
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
    uses: { [useId]: use },
  };
}

describe('macro registry', () => {
  it('registers the four versioned macros', () => {
    expect(Object.keys(MACROS).sort()).toEqual([
      'ciLoop@1',
      'openPullRequest@1',
      'reviewLoop@1',
      'validatePhase@1',
    ]);
    for (const [ref, def] of Object.entries(MACROS)) {
      expect(def.ref).toBe(ref);
      expect(getMacro(ref)).toBe(def);
    }
    expect(getMacro('ciLoop@2')).toBeUndefined();
    expect(getMacro('toString')).toBeUndefined();
  });

  it('lists the arguments that route out of each expansion', () => {
    expect(MACROS['ciLoop@1']?.edgeArgs).toEqual(['passed', 'exhausted', 'fix.handoff.rereview']);
    expect(MACROS['ciLoop@1']?.nodeIdArgs).toEqual(['fix.handoff.repush']);
    expect(MACROS['reviewLoop@1']?.edgeArgs).toEqual(['approved', 'afterFix', 'exhausted']);
    expect(MACROS['validatePhase@1']?.edgeArgs).toEqual(['next']);
    expect(MACROS['validatePhase@1']?.nodeIdArgs).toEqual(['successCriteriaId']);
    expect(MACROS['openPullRequest@1']?.edgeArgs).toEqual(['next']);
  });

  it.each(CASES)('$ref expands to exactly the helper output, tagged', ({ ref, args, helper }) => {
    const expansion = expandUse('blk', { args, macro: ref });
    expect(expansion).toEqual(tagAll(helper(), 'blk'));
    // Each node is a fresh clone: mutating one does not reach a second expansion.
    const first = Object.values(expansion)[0] as Record<string, unknown>;
    first.title = 'mutated';
    expect(expandUse('blk', { args, macro: ref })).toEqual(tagAll(helper(), 'blk'));
  });

  it.each(CASES)('$ref names its entry node', ({ ref, args, entry }) => {
    expect(useEntry({ args, macro: ref })).toBe(entry);
    expect(Object.keys(expandUse('blk', { args, macro: ref }))).toContain(entry);
  });

  it('agrees with the helpers on the entry ids', () => {
    expect(useEntry({ args: { fix: false, passed: 'x' }, macro: 'ciLoop@1' })).toBe(ciWaitEntry());
    expect(useEntry({ args: { next: 'x', ticketContext: true }, macro: 'validatePhase@1' })).toBe(
      validatePhaseEntry({ ticketContext: true })
    );
  });

  it.each([
    ['an unknown macro', { args: {}, macro: 'noSuchMacro@1' }, /unknown macro 'noSuchMacro@1'/],
    ['an unknown version', { args: {}, macro: 'ciLoop@9' }, /unknown version of macro 'ciLoop'/],
    ['a missing required argument', { args: { fix: false }, macro: 'ciLoop@1' }, /passed/],
    [
      'an extra argument',
      { args: { next: 'x', surprise: true }, macro: 'openPullRequest@1' },
      /invalid arguments/,
    ],
    ['a limit below 2', { args: { approved: 'x', limit: 1 }, macro: 'reviewLoop@1' }, /limit/],
    [
      'a non-integer limit',
      { args: { approved: 'x', limit: 2.5 }, macro: 'reviewLoop@1' },
      /limit/,
    ],
    [
      'an unknown handoff',
      { args: { fix: { handoff: { elsewhere: 'x' } }, passed: 'x' }, macro: 'ciLoop@1' },
      /invalid arguments for 'ciLoop@1': fix/,
    ],
    [
      'a wrong wait mode',
      { args: { fix: false, passed: 'x', wait: 'poll' }, macro: 'ciLoop@1' },
      /wait/,
    ],
    ['a blank node id', { args: { next: '' }, macro: 'validatePhase@1' }, /next/],
    ['non-object args', { args: 'next', macro: 'validatePhase@1' }, /invalid arguments/],
  ])('refuses %s', (_name, use, message) => {
    expect(() => expandUse('blk', use as MacroUse)).toThrow(MacroUseError);
    expect(() => expandUse('blk', use as MacroUse)).toThrow(message);
  });

  it.each(['', '1ci', 'ci-loop', 'ci loop', 'a'.repeat(33)])('refuses use id %j', (id) => {
    expect(isValidUseId(id)).toBe(false);
    expect(() => expandUse(id, { args: { next: 'x' }, macro: 'openPullRequest@1' })).toThrow(
      /use id/
    );
  });

  it.each(['ci', 'reviewLoop2', 'A', 'a'.repeat(32)])('accepts use id %j', (id) => {
    expect(isValidUseId(id)).toBe(true);
  });
});

describe('the use field and the uses map in the schema', () => {
  const plain = {
    description: '',
    entry: 'done',
    name: 'plain',
    nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
    schemaVersion: SPEC_SCHEMA_VERSION,
  };

  it('parses a spec without uses exactly as before', () => {
    const parsed = parseWorkflowSpec(plain);
    expect(Object.hasOwn(parsed, 'uses')).toBe(false);
    expect(Object.hasOwn(parsed.nodes.done as object, 'use')).toBe(false);
    expect(canonical(parsed)).toBe(canonical(plain));
  });

  it('carries the fields on a built-in template only where it was written with a macro', () => {
    for (const tmpl of BUILTIN_TEMPLATES) {
      const stored = JSON.parse(JSON.stringify(tmpl.spec));
      const tagged = Object.values(tmpl.spec.nodes).some((n) => n.use !== undefined);
      expect(Object.hasOwn(tmpl.spec, 'uses'), tmpl.name).toBe(tagged);
      // Both fields survive the schema, so a stored built-in keeps its authored form.
      expect(JSON.stringify(WorkflowSpecSchema.parse(stored)), tmpl.name).toBe(
        JSON.stringify(WorkflowSpecSchema.parse(JSON.parse(JSON.stringify(stored))))
      );
      expect(WorkflowSpecSchema.parse(stored).uses, tmpl.name).toEqual(tmpl.spec.uses);
    }
  });

  it('keeps a valid uses map and a use tag', () => {
    const spec = materializeUses(
      specWith('pr', { args: { next: 'done' }, macro: 'openPullRequest@1' })
    );
    const parsed = parseWorkflowSpec(spec);
    expect(parsed.uses).toEqual({ pr: { args: { next: 'done' }, macro: 'openPullRequest@1' } });
    expect(parsed.nodes.openPR?.use).toBe('pr');
  });

  it.each([
    ['a number', 7],
    ['an array', [{ args: {}, macro: 'x' }]],
    ['an entry without args', { pr: { macro: 'openPullRequest@1' } }],
    ['an entry with a numeric macro', { pr: { args: {}, macro: 1 } }],
  ])('degrades a malformed uses (%s) to absent instead of failing the parse', (_n, uses) => {
    const parsed = parseWorkflowSpec({ ...plain, uses });
    expect(parsed.uses).toBeUndefined();
    expect(canonical(parsed)).toBe(canonical(plain));
  });

  it.each([
    ['a number', 7],
    ['a blank string', '  '],
    ['an over-long string', 'u'.repeat(33)],
  ])('degrades a malformed use tag (%s) to absent', (_n, use) => {
    const node = NodeSchema.parse({ status: 'SUCCESS', type: 'terminate', use });
    expect(node.use).toBeUndefined();
    expect(JSON.stringify(node)).not.toMatch(/"use"/);
  });

  it('reports a malformed use tag on the authoring path', () => {
    const raw = {
      ...plain,
      nodes: {
        a: { status: 'SUCCESS', type: 'terminate', use: 'x'.repeat(33) },
        b: { status: 'SUCCESS', type: 'terminate', use: 'not-an-id' },
        c: { status: 'SUCCESS', type: 'terminate', use: 'fine' },
        done: { status: 'SUCCESS', type: 'terminate' },
      },
    };
    const issues = findInvalidPresentation(raw);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/node 'a'\.use/);
    expect(issues[1]).toMatch(/node 'b'\.use must be a letter/);
  });
});

describe('materializeUses', () => {
  const use: MacroUse = { args: { approved: 'done' }, macro: 'reviewLoop@1' };

  it('returns a spec without uses as the same reference', () => {
    const spec = { entry: 'done', nodes: { done: { status: 'SUCCESS', type: 'terminate' } } };
    expect(materializeUses(spec)).toBe(spec);
    const empty = { ...spec, uses: {} };
    expect(materializeUses(empty)).toBe(empty);
    expect(materializeUses(null)).toBe(null);
  });

  it("throws rather than replace a 'nodes' that is not an object", () => {
    for (const nodes of [[], 'x', 5, null]) {
      expect(() => materializeUses({ ...specWith('rev', use), nodes })).toThrow(MacroUseError);
    }
  });

  it('inserts the expansion of a use with no nodes, without mutating its argument', () => {
    const raw = specWith('rev', use);
    const before = structuredClone(raw);
    const out = materializeUses(raw);
    expect(raw).toEqual(before);
    expect(out).not.toBe(raw);
    expect(out.nodes).toEqual({ ...raw.nodes, ...expandUse('rev', use) });
    const parsed = parseWorkflowSpec(out);
    expect(findUseProblems(parsed)).toEqual([]);
    expect(validateSpec(parsed).errors).toEqual([]);
  });

  it('is idempotent', () => {
    const once = materializeUses(specWith('rev', use));
    const twice = materializeUses(once);
    expect(canonical(twice)).toBe(canonical(once));
  });

  it('leaves a use whose nodes are present alone, even when they have drifted', () => {
    const once = materializeUses(specWith('rev', use));
    const edited = {
      ...once,
      nodes: { ...once.nodes, review: { ...(once.nodes.review as Node), status: 'EDITED' } },
    };
    expect(materializeUses(edited).nodes).toEqual(edited.nodes);
  });

  it('refuses an expansion that would replace a hand-written node, naming it', () => {
    const raw = specWith('rev', use, { review: { status: 'SUCCESS', type: 'terminate' } });
    expect(() => materializeUses(raw)).toThrow(MacroUseError);
    expect(() => materializeUses(raw)).toThrow(/node 'review'.*hand-written/);
  });

  it('refuses two uses whose expansions share a node id', () => {
    const raw = {
      ...specWith('a', { args: { next: 'done' }, macro: 'openPullRequest@1' }),
      uses: {
        a: { args: { next: 'done' }, macro: 'openPullRequest@1' },
        b: { args: { next: 'done' }, macro: 'openPullRequest@1' },
      },
    };
    expect(() => materializeUses(raw)).toThrow(/use 'b'.*node 'openPR'.*from use 'a'/);
  });

  it('refuses a use it cannot expand', () => {
    const badArgs = {
      ...specWith('x', use),
      uses: { x: { args: {}, macro: 'openPullRequest@1' } },
    };
    expect(() => materializeUses(badArgs)).toThrow(/use 'x': invalid arguments/);
    const unknown = { ...specWith('x', use), uses: { x: { args: {}, macro: 'mystery@1' } } };
    expect(() => materializeUses(unknown)).toThrow(/use 'x': unknown macro 'mystery@1'/);
    expect(() => materializeUses({ nodes: {}, uses: 7 })).toThrow(/'uses' must be an object/);
  });
});

describe('reexpandUse and detachUse', () => {
  const use: MacroUse = { args: { fix: false, passed: 'done' }, macro: 'ciLoop@1' };

  it('re-expansion replaces drifted nodes and picks up changed arguments', () => {
    const spec = materializeUses(specWith('ci', use));
    const drifted = {
      ...spec,
      nodes: { ...spec.nodes, checkCI: { ...(spec.nodes.checkCI as Node), expr: 'false' } },
    };
    expect(findUseProblems(drifted)).toHaveLength(1);
    const repaired = reexpandUse(drifted, 'ci');
    expect(canonical(repaired)).toBe(canonical(spec));
    expect(findUseProblems(repaired)).toEqual([]);

    // A new argument set: the pollOrSignal wait adds nodes; the old ones go.
    const polled = {
      ...spec,
      uses: { ci: { args: { ...use.args, wait: 'pollOrSignal' }, macro: 'ciLoop@1' } },
    };
    expect(findUseProblems(polled)[0]).toMatch(/missing: .*loadCiWaitConfig/);
    const reexpanded = reexpandUse(polled, 'ci');
    expect(Object.keys(reexpanded.nodes)).toContain('pollForCI');
    expect(findUseProblems(reexpanded)).toEqual([]);
  });

  it('re-expansion removes tagged nodes the new expansion no longer has', () => {
    const polled: MacroUse = {
      args: { fix: false, passed: 'done', wait: 'pollOrSignal' },
      macro: 'ciLoop@1',
    };
    const spec = materializeUses(specWith('ci', polled));
    const back = reexpandUse({ ...spec, uses: { ci: use } }, 'ci');
    expect(Object.keys(back.nodes)).not.toContain('pollForCI');
    const { start: _s1, ...backNodes } = back.nodes;
    const { start: _s2, ...expected } = materializeUses(specWith('ci', use)).nodes;
    expect(canonical(backNodes)).toBe(canonical(expected));
    expect(findUseProblems(back)).toEqual([]);
  });

  it('refuses an unknown use id', () => {
    const spec = materializeUses(specWith('ci', use));
    expect(() => reexpandUse(spec, 'nope')).toThrow(/use 'nope' is not/);
    expect(() => detachUse(spec, 'nope')).toThrow(/use 'nope' is not/);
  });

  it('detach strips the tags, keeps the nodes and drops an emptied uses', () => {
    const spec = materializeUses(specWith('ci', use));
    const detached = detachUse(spec, 'ci');
    expect(Object.hasOwn(detached, 'uses')).toBe(false);
    for (const node of Object.values(detached.nodes)) {
      expect(Object.hasOwn(node as object, 'use')).toBe(false);
    }
    expect(Object.keys(detached.nodes).sort()).toEqual(Object.keys(spec.nodes).sort());
    expect(findUseProblems(detached)).toEqual([]);
    // Round trip: the detached spec is the plain spec the helper would have produced.
    const plain = {
      ...specWith('ci', use),
      nodes: { ...specWith('ci', use).nodes, ...ciLoop(use.args as never) },
    };
    const { uses: _u, ...plainNoUses } = plain;
    expect(canonical(detached)).toBe(canonical(plainNoUses));
  });

  it('detach keeps the other uses', () => {
    const raw = {
      ...specWith('ci', use),
      uses: { ci: use, pr: { args: { next: 'done' }, macro: 'openPullRequest@1' } },
    };
    const spec = materializeUses(raw);
    const detached = detachUse(spec, 'ci');
    expect(Object.keys(detached.uses ?? {})).toEqual(['pr']);
    expect(detached.nodes.openPR?.use).toBe('pr');
    expect(detached.nodes.checkCI && 'use' in detached.nodes.checkCI).toBe(false);
  });

  it('materialize → detach → re-tag round-trips', () => {
    const spec = materializeUses(specWith('ci', use));
    const detached = detachUse(spec, 'ci');
    const reattached = materializeUses({
      ...detached,
      nodes: Object.fromEntries(
        Object.entries(detached.nodes).filter(([id]) => !(id in expandUse('ci', use)))
      ),
      uses: { ci: use },
    });
    expect(canonical(reattached)).toBe(canonical(spec));
  });
});

describe('findUseProblems', () => {
  const use: MacroUse = { args: { next: 'done' }, macro: 'openPullRequest@1' };
  const good = () => materializeUses(specWith('pr', use));

  it('is empty for a consistent spec, raw or parsed', () => {
    expect(findUseProblems(good())).toEqual([]);
    expect(findUseProblems(parseWorkflowSpec(good()))).toEqual([]);
  });

  it('ignores presentation fields (group, title) but not real edits', () => {
    const spec = good();
    const nodes = spec.nodes as Record<string, Record<string, unknown>>;
    const id = 'openPR';
    const retitled = {
      ...spec,
      nodes: { ...nodes, [id]: { ...nodes[id], group: 'My group', title: 'Renamed' } },
    };
    expect(findUseProblems(retitled)).toEqual([]);
    const edited = {
      ...spec,
      nodes: { ...nodes, [id]: { ...nodes[id], status: 'EDITED' } },
    };
    expect(collectUseProblems(edited).map((p) => p.code)).toEqual(['USE_DRIFT']);
    const rerouted = {
      ...spec,
      nodes: { ...nodes, [id]: { ...nodes[id], next: 'elsewhere' } },
    };
    expect(collectUseProblems(rerouted).map((p) => p.code)).toEqual(['USE_DRIFT']);
  });

  it('ignores key order', () => {
    const spec = good();
    const reordered = Object.fromEntries(
      Object.entries(spec.nodes as Record<string, Record<string, unknown>>).map(([id, n]) => [
        id,
        Object.fromEntries(Object.entries(n).reverse()),
      ])
    );
    expect(findUseProblems({ ...spec, nodes: reordered })).toEqual([]);
  });

  const cases: Array<[string, (s: ReturnType<typeof good>) => unknown, string, RegExp]> = [
    [
      'an invalid use id',
      (s) => ({ ...s, uses: { 'bad-id': use, pr: use } }),
      'USE_INVALID_ID',
      /use 'bad-id'.*use id/,
    ],
    [
      'an unknown macro',
      (s) => ({ ...s, uses: { pr: { args: {}, macro: 'mystery@1' } } }),
      'USE_UNKNOWN_MACRO',
      /unknown macro 'mystery@1'/,
    ],
    [
      'an unknown version',
      (s) => ({ ...s, uses: { pr: { args: use.args, macro: 'openPullRequest@2' } } }),
      'USE_UNKNOWN_MACRO',
      /unknown version of macro 'openPullRequest'/,
    ],
    [
      'arguments the schema refuses',
      (s) => ({
        ...s,
        uses: { pr: { args: { draft: 'yes', next: 'done' }, macro: 'openPullRequest@1' } },
      }),
      'USE_INVALID_ARGS',
      /invalid arguments for 'openPullRequest@1': draft/,
    ],
    [
      'a malformed entry',
      (s) => ({ ...s, uses: { pr: 'openPullRequest@1' } }),
      'USE_INVALID',
      /must be an object/,
    ],
    [
      'a node tagged with an undeclared use',
      (s) => ({
        ...s,
        nodes: { ...s.nodes, done: { status: 'SUCCESS', type: 'terminate', use: 'ghost' } },
      }),
      'USE_NOT_DECLARED',
      /node 'done' is tagged with use 'ghost'/,
    ],
    [
      'a use with no tagged nodes',
      (s) => ({
        ...s,
        uses: {
          ...(s.uses as object),
          other: { args: { approved: 'done' }, macro: 'reviewLoop@1' },
        },
      }),
      'USE_NO_NODES',
      /use 'other' \(reviewLoop@1\) has no nodes/,
    ],
    [
      'a hand-edited node (drift)',
      (s) => ({
        ...s,
        nodes: { ...s.nodes, openPR: { ...(s.nodes.openPR as Node), status: 'EDITED' } },
      }),
      'USE_DRIFT',
      /use 'pr' \(openPullRequest@1\) has drifted.*changed: openPR.*re-expand.*detach/,
    ],
    [
      'a removed node (drift)',
      (s) => {
        const { savePrInfo: _gone, ...nodes } = s.nodes as Record<string, unknown>;
        return { ...s, nodes };
      },
      'USE_DRIFT',
      /missing: savePrInfo/,
    ],
    [
      'an extra tagged node (drift)',
      (s) => ({
        ...s,
        nodes: { ...s.nodes, extra: { status: 'SUCCESS', type: 'terminate', use: 'pr' } },
      }),
      'USE_DRIFT',
      /not in the expansion: extra/,
    ],
    [
      'arguments changed without re-expanding (drift)',
      (s) => ({
        ...s,
        uses: { pr: { args: { draft: true, next: 'done' }, macro: 'openPullRequest@1' } },
      }),
      'USE_DRIFT',
      /changed: openPR/,
    ],
  ];

  it.each(cases)('reports %s', (_name, mutate, code, message) => {
    const spec = mutate(good()) as Parameters<typeof findUseProblems>[0];
    const problems = collectUseProblems(spec);
    expect(problems.map((p) => p.code)).toEqual([code]);
    expect(findUseProblems(spec)).toEqual([expect.stringMatching(message)]);
  });

  it('surfaces each problem as a validateSpec error', () => {
    const spec = good();
    const drifted = parseWorkflowSpec({
      ...spec,
      nodes: { ...spec.nodes, openPR: { ...(spec.nodes.openPR as Node), status: 'EDITED' } },
    });
    const report = validateSpec(drifted);
    expect(report.errors).toEqual([
      expect.objectContaining({
        code: 'USE_DRIFT',
        field: 'use',
        nodeId: 'openPR',
        severity: 'error',
      }),
    ]);
    const undeclared = parseWorkflowSpec({
      ...spec,
      uses: { other: { args: { approved: 'done' }, macro: 'reviewLoop@1' }, pr: use },
    });
    expect(validateSpec(undeclared).errors).toEqual([
      expect.objectContaining({ code: 'USE_NO_NODES', field: 'uses.other', severity: 'error' }),
    ]);
  });
});

describe('the built-in templates', () => {
  const ticketToMerge = BUILTIN_TEMPLATES.find((t) => t.name === 'ticket-to-merge')
    ?.spec as WorkflowSpec;

  it('ticket-to-merge still validates, with no use problems', () => {
    expect(ticketToMerge).toBeDefined();
    expect(findUseProblems(ticketToMerge)).toEqual([]);
    expect(validateSpec(ticketToMerge).errors).toEqual([]);
  });

  it('every built-in has no use problems', () => {
    for (const tmpl of BUILTIN_TEMPLATES) {
      expect(findUseProblems(tmpl.spec), tmpl.name).toEqual([]);
    }
  });

  it('ticket-to-merge described by uses is consistent and detaches back to the seeded spec', () => {
    const uses: Record<string, MacroUse> = {
      ci: {
        args: {
          exhausted: 'lessonCIFailed',
          fix: { handoff: { rereview: 'review' } },
          passed: 'waitForHumanMerge',
          wait: 'pollOrSignal',
        },
        macro: 'ciLoop@1',
      },
      pr: {
        args: { next: ciWaitEntry('pollOrSignal'), status: 'AWAITING_CI' },
        macro: 'openPullRequest@1',
      },
      review: {
        args: { afterFix: 'clearCiResult', approved: 'openPR', exhausted: 'lessonReviewFailed' },
        macro: 'reviewLoop@1',
      },
      validate: {
        args: { next: 'implement', stopIfNotActionable: true, ticketContext: true },
        macro: 'validatePhase@1',
      },
    };
    // The built-in records exactly these uses; the rest of the test starts from its plain form.
    expect(ticketToMerge.uses).toEqual(uses);
    const { uses: _recorded, ...plainTicketToMerge } = ticketToMerge;
    const flat: Record<string, Node> = Object.fromEntries(
      Object.entries(plainTicketToMerge.nodes).map(([id, node]) => {
        const { use: _tag, ...rest } = node as Node & { use?: string };
        return [id, rest as Node];
      })
    );
    const nodes: Record<string, Node> = { ...flat };
    for (const [useId, use] of Object.entries(uses)) {
      for (const id of Object.keys(expandUse(useId, use))) {
        nodes[id] = { ...(nodes[id] as Node), use: useId };
      }
    }
    const authored = parseWorkflowSpec({ ...plainTicketToMerge, nodes, uses });
    expect(findUseProblems(authored)).toEqual([]);
    expect(validateSpec(authored).errors).toEqual([]);
    // Every use's entry is a node the template routes to.
    expect(useEntry(uses.validate as MacroUse)).toBe(ticketToMerge.entry);

    let plain: WorkflowSpec = authored;
    for (const useId of Object.keys(uses)) {
      plain = detachUse(plain, useId);
    }
    expect(canonical(plain)).toBe(
      canonical(parseWorkflowSpec({ ...plainTicketToMerge, nodes: flat }))
    );
  });
});

/** sha256 of the sorted-key JSON of an expansion. */
const digest = (nodes: NodeMap): string =>
  createHash('sha256').update(canonical(nodes)).digest('hex');

describe('macro versions are frozen', () => {
  // A macro version never changes what it expands to: a stored `@1` use is compared
  // against the live expansion, so any change to a helper would turn every stored use
  // into drift. Argument sets cover every option of every macro.
  const FROZEN: Array<[string, string, Record<string, unknown>, string]> = [];
  const frozen = (label: string, ref: string, args: Record<string, unknown>, hash: string) =>
    FROZEN.push([label, ref, args, hash]);

  frozen(
    'ciLoop minimal',
    'ciLoop@1',
    { fix: false, passed: 'done' },
    'a428e0ebc056a913176d106610d3422cfbcd63d54547596401ce0608ef29cc69'
  );
  frozen(
    'ciLoop poll, exhausted',
    'ciLoop@1',
    { exhausted: 'lessonCIFailed', fix: false, passed: 'done', wait: 'pollOrSignal' },
    '938172f10ec343c741e4b89705f218c21671d09e6f32b6e901fff80485f7d11c'
  );
  frozen(
    'ciLoop signal wait',
    'ciLoop@1',
    { fix: false, passed: 'done', wait: 'signal' },
    'a428e0ebc056a913176d106610d3422cfbcd63d54547596401ce0608ef29cc69'
  );
  frozen(
    'ciLoop repush defaults',
    'ciLoop@1',
    { fix: { handoff: { repush: 'pushFix' } }, passed: 'done' },
    '53ba93eb482aa43469b5b168f3531c3d46eff87438ea46996c0045f75fd6a7e6'
  );
  frozen(
    'ciLoop repush status, numeric limit',
    'ciLoop@1',
    { fix: { handoff: { repush: 'pushFix', status: 'AWAITING_CI' }, limit: 5 }, passed: 'done' },
    'f62383d1aa9114bbd4f4ee10165c6c63e91d35be8fc804abba88cf2294c212ba'
  );
  frozen(
    'ciLoop repush string limit, retryIfUnchanged',
    'ciLoop@1',
    {
      fix: {
        handoff: { repush: 'pushFix' },
        limit: 'request.payload.maxFixes ?? 2',
        retryIfUnchanged: true,
      },
      passed: 'done',
    },
    '7bf1b7fd827dd5ebffab07fc005157d2a02ee0352b0356b6507ef5bfa3ae532e'
  );
  frozen(
    'ciLoop retryIfUnchanged false',
    'ciLoop@1',
    { fix: { handoff: { repush: 'pushFix' }, retryIfUnchanged: false }, passed: 'done' },
    '53ba93eb482aa43469b5b168f3531c3d46eff87438ea46996c0045f75fd6a7e6'
  );
  frozen(
    'ciLoop rereview',
    'ciLoop@1',
    { fix: { handoff: { rereview: 'review' } }, passed: 'done' },
    '30722649f99e6148118f48f058a469d3aa133cd402e04103ff3fcdc763766d50'
  );
  frozen(
    'ciLoop rereview, poll, exhausted, limit',
    'ciLoop@1',
    {
      exhausted: 'lessonCIFailed',
      fix: { handoff: { rereview: 'review' }, limit: 3 },
      passed: 'waitForHumanMerge',
      wait: 'pollOrSignal',
    },
    '9a7b07b48755a7d969024c1f6520764476bf94505b6ae66cb64f43a299c89145'
  );
  frozen(
    'reviewLoop minimal',
    'reviewLoop@1',
    { approved: 'done' },
    'd4c06095e2a646940d2265417471a21893bd4a889bd053c08ca106a6379289cf'
  );
  frozen(
    'reviewLoop afterFix, exhausted',
    'reviewLoop@1',
    { afterFix: 'clearCiResult', approved: 'openPR', exhausted: 'lessonReviewFailed' },
    '894f85f770bd0a3e15879cc8027bba793197589a61aa96979b4a84c70b0bf59d'
  );
  frozen(
    'reviewLoop limit, fixConfig',
    'reviewLoop@1',
    { approved: 'done', fixConfig: { allowedPaths: ['docs/**'] }, limit: 4 },
    'dda030ba56b24b34d6989822ee15819cca670d1ede547b540d95e5363024d3d1'
  );
  frozen(
    'validatePhase minimal',
    'validatePhase@1',
    { next: 'implement' },
    'c6bc9be7c1beb1a9eebb5283d6f326ae53d0c06bd23d5d7f7044e62ef4dbd99b'
  );
  frozen(
    'validatePhase stamp off',
    'validatePhase@1',
    { next: 'implement', stamp: false },
    'dab46a58eb5a799bf22ac7116da3e1382403d8be9ad5e188ede972e42cf4711a'
  );
  frozen(
    'validatePhase stamp on',
    'validatePhase@1',
    { next: 'implement', stamp: true },
    'c6bc9be7c1beb1a9eebb5283d6f326ae53d0c06bd23d5d7f7044e62ef4dbd99b'
  );
  frozen(
    'validatePhase stopIfNotActionable, ticketContext',
    'validatePhase@1',
    { next: 'implement', stopIfNotActionable: true, ticketContext: true },
    '58b4bc84f59bd798d5e3efa9404451ee2ab6b054ddc975107d18fe4e0226a274'
  );
  frozen(
    'validatePhase successCriteria',
    'validatePhase@1',
    { next: 'implement', successCriteria: true },
    'c6bc9be7c1beb1a9eebb5283d6f326ae53d0c06bd23d5d7f7044e62ef4dbd99b'
  );
  frozen(
    'validatePhase successCriteria custom id',
    'validatePhase@1',
    { next: 'implement', successCriteria: true, successCriteriaId: 'criteria' },
    '0175f814d9a37b9adc6ce900b497a6a50e76669598279f975535ffd64596ab89'
  );
  frozen(
    'validatePhase everything',
    'validatePhase@1',
    {
      next: 'implement',
      stamp: true,
      stopIfNotActionable: true,
      successCriteria: true,
      successCriteriaId: 'criteria',
      ticketContext: true,
    },
    '1d9e04ca712b366256fb678b119a6f4cfdb1ed57ea20409c1b1ce5e5573e53b4'
  );
  frozen(
    'openPullRequest minimal',
    'openPullRequest@1',
    { next: 'waitForCI' },
    '9be07e328b0691243ef54065bd38e54b2c28b1818c31472b33d84adef43befc8'
  );
  frozen(
    'openPullRequest not draft',
    'openPullRequest@1',
    { draft: false, next: 'waitForCI' },
    '9be07e328b0691243ef54065bd38e54b2c28b1818c31472b33d84adef43befc8'
  );
  frozen(
    'openPullRequest draft',
    'openPullRequest@1',
    { draft: true, next: 'waitForCI' },
    'd84e0dcbbc3c77607443a815630497554a36c1f5a568ef599459eb235ec8ec26'
  );
  frozen(
    'openPullRequest resetCiRetries, status',
    'openPullRequest@1',
    { next: 'waitForCI', resetCiRetries: true, status: 'AWAITING_CI' },
    '4d53f1daba5c00006c1ac6187d7a82055a91833b240267950cbb271a3d5dc6a3'
  );
  frozen(
    'openPullRequest resetCiRetries off',
    'openPullRequest@1',
    { next: 'waitForCI', resetCiRetries: false },
    '9be07e328b0691243ef54065bd38e54b2c28b1818c31472b33d84adef43befc8'
  );

  it.each(FROZEN)('%s expands to the recorded nodes', (label, ref, args, hash) => {
    const actual = digest(expandUse('u', { args, macro: ref }) as NodeMap);
    expect(
      actual,
      `${label}: a macro version never changes what it expands to: ship the new behaviour as @2 and keep @1`
    ).toBe(hash);
  });
});
