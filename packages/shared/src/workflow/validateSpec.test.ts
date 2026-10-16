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

describe('validateSpec SIGNAL_SHARED_ACROSS_BRANCHES', () => {
  const wait = {
    name: 'ciPipelineSignal',
    onReceive: 'ok',
    onTimeout: 'late',
    timeout: '1h',
    type: 'signal',
  };
  const fanWithSignal = (fan: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    spec(
      {
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'prep', type: 'fanOut', ...fan },
        late: { status: 'FAILED', type: 'terminate' },
        ok: { status: 'SUCCESS', type: 'terminate' },
        prep: { next: 'wait', step: 'executeImplementation', type: 'step' },
        wait,
        ...extra,
      },
      'fan'
    );
  const shared = (s: ReturnType<typeof spec>) =>
    validateSpec(s).warnings.filter((w) => w.code === 'SIGNAL_SHARED_ACROSS_BRANCHES');

  it('warns on a signal reachable inside a fan-out with the default concurrency', () => {
    const found = shared(fanWithSignal({}));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: 'name', nodeId: 'wait', severity: 'warning' });
    expect(found[0]?.message).toContain("'ciPipelineSignal'");
    expect(found[0]?.message).toContain("fan-out 'fan'");
    expect(found[0]?.message).toContain('wakes only one branch');
  });

  it('warns when the fan-out runs more than one branch at a time', () => {
    expect(shared(fanWithSignal({ concurrency: 3 }))).toHaveLength(1);
  });

  it('is quiet when the fan-out runs its branches one at a time', () => {
    expect(shared(fanWithSignal({ concurrency: 1 }))).toEqual([]);
  });

  it('is quiet for a signal in the main flow, outside any branch', () => {
    const report = validateSpec(
      spec(
        {
          after: wait,
          branch: { step: 'executeImplementation', type: 'step' },
          fan: { join: 'after', over: { literal: [1, 2] }, subgraph: 'branch', type: 'fanOut' },
          late: { status: 'FAILED', type: 'terminate' },
          ok: { status: 'SUCCESS', type: 'terminate' },
        },
        'fan'
      )
    );
    expect(report.warnings.map((w) => w.code)).not.toContain('SIGNAL_SHARED_ACROSS_BRANCHES');
  });

  it('warns once for a signal inside a sequential fan-out nested in a concurrent one', () => {
    const report = validateSpec(
      spec(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          inner: {
            concurrency: 1,
            join: 'innerDone',
            over: { literal: [1, 2] },
            subgraph: 'wait',
            type: 'fanOut',
          },
          innerDone: { status: 'SUCCESS', type: 'terminate' },
          late: { status: 'FAILED', type: 'terminate' },
          ok: { status: 'SUCCESS', type: 'terminate' },
          outer: { join: 'done', over: { literal: [1, 2] }, subgraph: 'inner', type: 'fanOut' },
          wait,
        },
        'outer'
      )
    );
    const found = report.warnings.filter((w) => w.code === 'SIGNAL_SHARED_ACROSS_BRANCHES');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("fan-out 'outer'");
  });

  it('does not warn on HITL nodes, which wait on a per-branch signal name', () => {
    const report = validateSpec(
      spec(
        {
          done: { status: 'SUCCESS', type: 'terminate' },
          fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'gate', type: 'fanOut' },
          gate: {
            onApprove: 'ok',
            onReject: 'ok',
            onTimeout: 'ok',
            timeout: '24h',
            title: 'Approve?',
            type: 'humanApproval',
          },
          ok: { status: 'SUCCESS', type: 'terminate' },
        },
        'fan'
      )
    );
    expect(report.warnings.map((w) => w.code)).not.toContain('SIGNAL_SHARED_ACROSS_BRANCHES');
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

  it('warns on eval-node fields no scorer reads', () => {
    const report = validateSpec(
      spec({
        a: {
          inputs: { diff: { from: 'input.diff' } },
          next: 'done',
          scorers: [
            { from: 'nodes.x.traces', kind: 'trajectory' },
            { baselineFrom: 'nodes.x.baseline', kind: 'judge', rubricRef: 'code-review-quality' },
          ],
          target: { from: 'input.diff' },
          type: 'eval',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    const ignored = report.warnings.filter((w) => w.code === 'IGNORED_FIELD');
    expect(ignored.map((w) => w.field).sort()).toEqual([
      'inputs',
      'scorers[0].from',
      'scorers[1].baselineFrom',
    ]);
    expect(ignored.every((w) => w.nodeId === 'a' && w.severity === 'warning')).toBe(true);
  });

  it('warns on spanName for mcp and eval nodes, which ignore it, but not for agent', () => {
    const report = validateSpec(
      spec(
        {
          agent: { agentRef: 'planner', next: 'tool', spanName: 'mine', type: 'agent' },
          done: { status: 'SUCCESS', type: 'terminate' },
          score: {
            next: 'done',
            scorers: [{ kind: 'pii' }],
            spanName: 'mine',
            target: { from: 'input.diff' },
            type: 'eval',
          },
          tool: { connectionRef: 'c', next: 'score', spanName: 'mine', tool: 't', type: 'mcp' },
        },
        'agent'
      )
    );
    const ignored = report.warnings.filter((w) => w.code === 'IGNORED_FIELD');
    expect(ignored.map((w) => [w.nodeId, w.field]).sort()).toEqual([
      ['score', 'spanName'],
      ['tool', 'spanName'],
    ]);
  });

  it('does not warn on an eval node that sets none of them, or an empty inputs map', () => {
    const report = validateSpec(
      spec({
        a: {
          inputs: {},
          next: 'done',
          scorers: [{ kind: 'trajectory' }, { kind: 'judge', rubricRef: 'code-review-quality' }],
          target: { from: 'input.diff' },
          type: 'eval',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(report.warnings.filter((w) => w.code === 'IGNORED_FIELD')).toEqual([]);
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

  it('lints an eval node candidateRef binding like its target', () => {
    // The interpreter resolves `candidateRef` the same way, so a mistyped path
    // must be reported rather than silently scoring the run's own branch.
    const r = validateSpec(
      spec({
        a: {
          candidateRef: { from: 'nodes.ghost.output.branch' },
          next: 'done',
          scorers: [{ gate: 'runTests', kind: 'gate' }],
          target: { from: 'nodes.ghost.output.diff' },
          type: 'eval',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    const ref = r.warnings.filter((w) => w.code === 'UNKNOWN_NODE_REF' && w.nodeId === 'a');
    // Both bindings are reported: `target`'s path and `candidateRef`'s.
    expect(ref.map((w) => w.message)).toEqual([
      expect.stringContaining('nodes.ghost.output.diff'),
      expect.stringContaining('nodes.ghost.output.branch'),
    ]);
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

describe('the executor step spelling', () => {
  // `step: 'runEvalNode'` and its three siblings dispatch exactly as the typed
  // node does, so a spec using them is not refused — but only the node type has
  // typed fields and an inspector form, so the author is pointed at it.
  const cases: Array<[string, string]> = [
    ['runAgentNode', 'agent'],
    ['runEvalNode', 'eval'],
    ['mcpCallTool', 'mcp'],
    ['runContainerStep', 'containerStep'],
  ];

  it.each(cases)('warns that step %s is the %s node’s executor', (step, nodeType) => {
    const r = validateSpec(
      spec({
        a: { next: 'done', step, type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    const warning = r.warnings.find((w) => w.code === 'STEP_HAS_TYPED_NODE' && w.nodeId === 'a');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain(`\`${nodeType}\``);
    // Advisory only: the run still works, so it is not an error.
    expect(r.errors).toEqual([]);
  });

  it('says nothing about an ordinary step', () => {
    const r = validateSpec(
      spec({
        a: { next: 'done', step: 'runLint', type: 'step' },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.warnings.filter((w) => w.code === 'STEP_HAS_TYPED_NODE')).toEqual([]);
  });
});

describe('validateSpec expression lint: assert scorers and approverCount', () => {
  const evalSpec = (expr: string) =>
    spec({
      a: {
        next: 'done',
        scorers: [{ expr, kind: 'assert' }],
        target: { from: 'input.diff' },
        type: 'eval',
      },
      done: { status: 'SUCCESS', type: 'terminate' },
    });

  it('flags a malformed assert expression', () => {
    const r = validateSpec(evalSpec('$.linesChanged ==='));
    expect(r.errors.some((e) => e.code === 'EXPR_SYNTAX' && e.field === 'scorers[0].expr')).toBe(
      true
    );
  });

  it('accepts a valid $.-prefixed assert expression', () => {
    const r = validateSpec(evalSpec('$.x == 1 && $.linesChanged < 500'));
    expect(r.errors.filter((e) => e.code === 'EXPR_SYNTAX')).toEqual([]);
  });

  it('flags a malformed approverCount expression', () => {
    const r = validateSpec(
      spec({
        a: {
          approverCount: { expr: 'nodes.x.output.n ===' },
          onApprove: 'done',
          onReject: 'done',
          onTimeout: 'done',
          timeout: '1h',
          title: 'Approve',
          type: 'humanApproval',
        },
        done: { status: 'SUCCESS', type: 'terminate' },
      })
    );
    expect(r.errors.some((e) => e.code === 'EXPR_SYNTAX' && e.field === 'approverCount')).toBe(
      true
    );
  });
});

describe('validateSpec: the publishOutcome risk class is declared, not bound', () => {
  const errorsFor = (nodes: Record<string, unknown>, entry: string) =>
    validateSpec(spec(nodes, entry)).errors.filter((e) => e.code === 'ACTION_CLASS_BOUND');

  it('flags a class supplied as an input', () => {
    // A payload-fillable class is a class the *launcher* chooses, and the approval guard holds a run
    // for a requirement from any class — so the claimant would set the very gate it then walks
    // through. The step registry declares this field under `config`; the executor reads nothing else.
    expect(
      errorsFor(
        {
          do: {
            inputs: { action: { from: 'request.payload.action' } },
            next: 'done',
            step: 'publishOutcome',
            type: 'step',
          },
          done: { status: 'SUCCESS', type: 'terminate' },
        },
        'do'
      )
    ).toHaveLength(1);
  });

  it('accepts the class declared under config', () => {
    expect(
      errorsFor(
        {
          do: {
            config: { action: 'external_write' },
            next: 'done',
            step: 'publishOutcome',
            type: 'step',
          },
          done: { status: 'SUCCESS', type: 'terminate' },
        },
        'do'
      )
    ).toHaveLength(0);
  });

  it('leaves another step’s inputs alone', () => {
    // Only the class is refused: `inputs.action` on a step that does not read it is somebody else's
    // field, and guessing at their meaning is how a lint rule starts refusing valid specs.
    expect(
      errorsFor(
        {
          do: {
            inputs: { action: { literal: 'anything' } },
            next: 'done',
            step: 'runTool',
            type: 'step',
          },
          done: { status: 'SUCCESS', type: 'terminate' },
        },
        'do'
      )
    ).toHaveLength(0);
  });
});
