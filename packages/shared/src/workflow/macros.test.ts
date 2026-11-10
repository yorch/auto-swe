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

  it('adds neither field to any built-in template', () => {
    for (const tmpl of BUILTIN_TEMPLATES) {
      const stored = JSON.parse(JSON.stringify(tmpl.spec));
      expect(Object.hasOwn(tmpl.spec, 'uses'), tmpl.name).toBe(false);
      expect(JSON.stringify(tmpl.spec), tmpl.name).not.toMatch(/"uses?"/);
      expect(JSON.stringify(WorkflowSpecSchema.parse(stored)), tmpl.name).not.toMatch(/"uses?"/);
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
      nodes: { ...once.nodes, review: { ...(once.nodes.review as Node), title: 'Edited' } },
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
      nodes: { ...spec.nodes, checkCI: { ...(spec.nodes.checkCI as Node), title: 'Hand edit' } },
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
        nodes: { ...s.nodes, openPR: { ...(s.nodes.openPR as Node), title: 'Edited' } },
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
      nodes: { ...spec.nodes, openPR: { ...(spec.nodes.openPR as Node), title: 'Edited' } },
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
    const nodes: Record<string, Node> = { ...ticketToMerge.nodes };
    for (const [useId, use] of Object.entries(uses)) {
      for (const id of Object.keys(expandUse(useId, use))) {
        nodes[id] = { ...(nodes[id] as Node), use: useId };
      }
    }
    const authored = parseWorkflowSpec({ ...ticketToMerge, nodes, uses });
    expect(findUseProblems(authored)).toEqual([]);
    expect(validateSpec(authored).errors).toEqual([]);
    // Every use's entry is a node the template routes to.
    expect(useEntry(uses.validate as MacroUse)).toBe(ticketToMerge.entry);

    let plain: WorkflowSpec = authored;
    for (const useId of Object.keys(uses)) {
      plain = detachUse(plain, useId);
    }
    expect(canonical(plain)).toBe(canonical(parseWorkflowSpec(ticketToMerge)));
  });
});
