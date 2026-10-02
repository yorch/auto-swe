/**
 * Authoring helpers for the built-in templates.
 *
 * A built-in template is a flat {@link WorkflowSpec}: plain nodes in a map, with
 * no macro, composite or sub-workflow node anywhere in the spec. These helpers
 * are ordinary functions that run when the template module loads and RETURN
 * those plain nodes, under the same ids the templates have always used. That is
 * the whole contract:
 *
 *   - the engine, the worker, replay, run snapshots, template analytics (keyed
 *     by node id) and bundle hashes see a flat spec and nothing else;
 *   - a helper is not a new node type and never appears in a stored spec;
 *   - `golden.test.ts` holds every built-in to the flat spec it was seeded as.
 *
 * Helpers return a node map to be spread into a template's `nodes`. Where a
 * helper wires into the rest of a template it takes the target node id as a
 * plain string, so the template still names every join point itself.
 */

import type { Binding, Node } from '../../spec.js';

export type NodeMap = Record<string, Node>;

/** Presentation-only fields a helper stamps on the nodes it emits. */
export interface Presentation {
  group?: string;
  title?: string;
}

const present = (p?: Presentation): Presentation => ({
  ...(p?.group !== undefined ? { group: p.group } : {}),
  ...(p?.title !== undefined ? { title: p.title } : {}),
});

/**
 * The `{ prNumber, prUrl }` result every pull-request template reports. A fresh
 * object per call, so no two nodes share a mutable reference.
 */
export function prResult(): Record<string, Binding> {
  return { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } };
}

/**
 * A `terminate` node. `result` is omitted from the node unless given, so
 * `terminate('FAILED')` and `terminate('TIMED_OUT', { result: {} })` stay the two
 * different nodes they are in the specs that use them.
 */
export function terminate(
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED',
  opts: { result?: Record<string, Binding> } & Presentation = {}
): Node {
  return {
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...present(opts),
    status,
    type: 'terminate',
  };
}

/**
 * A status stamp: an `updateDomainState` step that writes the run's phase label
 * to `ActiveWorkflow.currentStatus` before the work of that phase starts.
 */
export function statusStamp(status: string, next: string, p: Presentation = {}): Node {
  return {
    config: { status },
    next,
    step: 'updateDomainState',
    ...present({ title: `Set status: ${status}`, ...p }),
    type: 'step',
  };
}

/**
 * A `set` node that stores the implementer's output as `context.currentCodeResult`,
 * the shape every later step reads. `from` defaults to the node id `implement`.
 */
export function storeCodeResult(next: string, p: Presentation = {}, from = 'implement'): Node {
  return {
    next,
    ...present({ title: 'Keep the implementation', ...p }),
    type: 'set',
    values: { 'context.currentCodeResult': { from: `nodes.${from}.output` } },
  };
}

const GATE_TITLES: Record<string, string> = {
  runLint: 'Lint',
  runTests: 'Run the tests',
  runTypecheck: 'Typecheck',
  runVulnScan: 'Scan for vulnerabilities',
};

/**
 * A local quality gate (`runLint`, `runTypecheck`, `runTests`, `runVulnScan`).
 * In warn mode (`onFail: 'warn'`) a failure is recorded and the run goes on, so
 * the gate informs the reviewers rather than blocking.
 */
export function qualityGate(step: string, next: string, p: Presentation = {}): Node {
  return {
    next,
    onFail: 'warn',
    step,
    ...present({ title: GATE_TITLES[step] ?? `Run ${step}`, ...p }),
    type: 'step',
  };
}

/**
 * The `set` node that opens the implement-then-review flow: it initialises the
 * retry counters and keeps the implementer's output as `context.currentCodeResult`.
 * `ci` / `review` choose which counters exist (both by default); a template only
 * initialises the loops it has.
 */
export function initCounters(
  next: string,
  opts: { ci?: boolean; review?: boolean } & Presentation = {}
): Node {
  return {
    next,
    ...present({ title: 'Initialise the counters', ...opts }),
    type: 'set',
    values: {
      ...(opts.ci === false ? {} : { 'context.ciRetries': { literal: 0 } }),
      'context.currentCodeResult': { from: 'nodes.implement.output' },
      ...(opts.review === false ? {} : { 'context.reviewRetries': { literal: 0 } }),
    },
  };
}

/**
 * Stamp a group on every node of a map that has none, leaving the rest alone.
 * For the hand-authored nodes that sit between the helpers' output.
 */
export function inGroup(group: string, nodes: NodeMap): NodeMap {
  return Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [
      id,
      node.group === undefined ? { ...node, group } : node,
    ])
  );
}
