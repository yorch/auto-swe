import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Node, parseWorkflowSpec, type WorkflowSpec } from '../spec.js';
import { BUILTIN_TEMPLATES } from './index.js';

/**
 * Golden check for the built-in templates.
 *
 * `__golden__/<name>.json` is each template's FLAT spec as it was seeded before
 * the templates were rewritten on top of the authoring helpers
 * (`authoring/`). The helpers expand at module load into plain nodes, so what
 * the engine, a run snapshot, template analytics and a bundle hash see must not
 * move: the built spec has to equal its golden, node for node and id for id.
 *
 * The ONLY permitted differences are the entries in {@link INTENDED_CHANGES}
 * below, each with its reason, plus the presentation fields (`group`, and
 * `title` where a node has no inbox title) the helpers add and this test
 * strips before comparing.
 */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__golden__');

function golden(name: string): WorkflowSpec {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as WorkflowSpec;
}

/** Drop `group`, and `title` on every node type that did not already have one. */
function stripPresentation(spec: WorkflowSpec): WorkflowSpec {
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const { group: _group, ...rest } = node as Node & { group?: string };
    if (node.type.startsWith('human')) {
      nodes[id] = rest as Node;
    } else {
      const { title: _title, ...noTitle } = rest as Node & { title?: string };
      nodes[id] = noTitle as Node;
    }
  }
  return { ...spec, nodes };
}

/** Remove a pass-through node, pointing everything that targeted it at its `next`. */
function removePassThrough(spec: WorkflowSpec, id: string): WorkflowSpec {
  const removed = spec.nodes[id] as Node & { next?: string };
  const to = removed.next as string;
  const retarget = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(retarget);
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retarget(x)]));
    }
    return v === id ? to : v;
  };
  const nodes: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (nodeId !== id) {
      nodes[nodeId] = retarget(node);
    }
  }
  return {
    ...spec,
    entry: spec.entry === id ? to : spec.entry,
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/**
 * The CI fix loop `consensus-review` and `four-eyes` gained: a failing CI is no longer terminal
 * but fetches the logs, asks the implementer for a fix (3 attempts, as in default-engineering),
 * and sends the fixed code back through `rereview` (their review gate, so an approval never
 * covers code it did not see) before the pull request is updated. Also initialises the counter.
 */
function withCiFixLoop(g: WorkflowSpec, rereview: string, description: string): WorkflowSpec {
  const nodes: Record<string, unknown> = { ...g.nodes };
  const init = nodes.initCounters as { values: Record<string, unknown> };
  nodes.initCounters = {
    ...init,
    values: { 'context.ciRetries': { literal: 0 }, ...init.values },
  };
  nodes.checkCI = { ...(nodes.checkCI as object), onFalse: 'incCIRetries' };
  Object.assign(nodes, {
    checkCILimit: {
      expr: 'context.ciRetries >= 3',
      onFalse: 'fetchLogs',
      onTrue: 'terminateCIFailed',
      type: 'cond',
    },
    ciFix: {
      inputs: {
        failureContext: { from: 'context.lastCILogs' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'updateCodeAfterCIFix',
      step: 'executeCIFixImplementation',
      type: 'step',
    },
    clearCiResult: {
      next: rereview,
      type: 'set',
      values: { 'context.ciResultPayload': { literal: null } },
    },
    fetchLogs: {
      inputs: { logsUrl: { from: 'context.ciResultPayload.logsUrl' } },
      next: 'storeLogs',
      step: 'fetchCILogs',
      type: 'step',
    },
    incCIRetries: {
      next: 'checkCILimit',
      type: 'set',
      values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
    },
    storeLogs: {
      next: 'ciFix',
      type: 'set',
      values: { 'context.lastCILogs': { from: 'nodes.fetchLogs.output' } },
    },
    updateCodeAfterCIFix: {
      next: 'clearCiResult',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
    },
  });
  return { ...g, description, nodes: nodes as WorkflowSpec['nodes'] };
}

/**
 * Deliberate departures from the golden, keyed by template name. Anything not
 * listed here must match exactly.
 */
const INTENDED_CHANGES: Record<
  string,
  { reason: string; apply: (g: WorkflowSpec) => WorkflowSpec }
> = {
  // Seven templates stamped COMPLETED just before their SUCCESS terminate. The finalizer
  // (`finalizeWorkflowRun`) already writes COMPLETED on a SUCCESS run, so the node was a
  // second write of the same fact. Removing it retargets what pointed at it to `done`.
  ...Object.fromEntries(
    [
      'agent-reviewed-pr',
      'code-and-ci',
      'default-engineering',
      'dependency-update',
      'pr-approval-gate',
    ].map((name) => [
      name,
      {
        apply: (g: WorkflowSpec) => removePassThrough(g, 'setCompleted'),
        reason: 'the finalizer already writes COMPLETED on SUCCESS',
      },
    ])
  ),
  // The two templates that ended the run on the first CI failure now fix and retry like
  // their siblings, in addition to the setCompleted removal above.
  'consensus-review': {
    apply: (g: WorkflowSpec) => withCiFixLoop(
        removePassThrough(g, 'setCompleted'),
        'fanOutReview',
        g.description.replace(
          ' Demonstrates',
          ' Then wait for CI; a CI failure is fixed by the agent (up to 3 times) and the fix goes back through both reviewers before the PR is updated. Demonstrates'
        )
      ),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; a CI failure is fixed and the fix ' +
      're-enters the two-reviewer consensus (up to 3 attempts) instead of failing the run',
  },
  'four-eyes': {
    apply: (g: WorkflowSpec) => withCiFixLoop(
        removePassThrough(g, 'setCompleted'),
        'setReviewing',
        g.description.replace(
          ' Models a',
          ' Then wait for CI; a CI failure is fixed by the agent (up to 3 times) and the fix goes back through the review and both sign-offs before the PR is updated. Models a'
        )
      ),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; a CI failure is fixed and the fix ' +
      're-enters the agent review and both sign-offs (up to 3 attempts) instead of failing the run',
  },
};

describe('built-in templates match their pre-helper golden specs', () => {
  it('has a golden file for every built-in template, and no stray ones', () => {
    const files = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(BUILTIN_TEMPLATES.map((t) => t.name).sort());
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.spec] as const))(
    '%s expands to its golden flat spec',
    (name, spec) => {
      const change = INTENDED_CHANGES[name];
      const expected = change ? change.apply(golden(name)) : golden(name);
      // Strict: a key left as `undefined` would pass toEqual but is not the golden's bytes.
      expect(stripPresentation(spec)).toStrictEqual(expected);
    }
  );

  it.each(BUILTIN_TEMPLATES.map((t) => t.name))(
    'the golden for %s is a spec as stored before group/title existed, and still parses',
    (name) => {
      const raw = golden(name);
      const parsed = parseWorkflowSpec(raw);
      expect(Object.keys(parsed.nodes)).toEqual(Object.keys(raw.nodes));
      for (const node of Object.values(raw.nodes)) {
        expect('group' in node).toBe(false);
      }
    }
  );

  it('keeps removePassThrough honest: it retargets every edge and the entry', () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'x',
      nodes: {
        a: { next: 'mid', step: 'runLint', type: 'step' },
        c: { expr: 'x == 1', onFalse: 'mid', onTrue: 'end', type: 'cond' },
        end: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'end', step: 'updateDomainState', type: 'step' },
      },
      schemaVersion: 1,
    });
    const out = removePassThrough(spec, 'mid');
    expect(Object.keys(out.nodes)).toEqual(['a', 'c', 'end']);
    expect((out.nodes.a as { next: string }).next).toBe('end');
    expect((out.nodes.c as { onFalse: string }).onFalse).toBe('end');
  });
});
