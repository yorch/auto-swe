import { expect } from 'vitest';
import { type Node, nodeEdges, SPEC_SCHEMA_VERSION, WorkflowSpecSchema } from '../../spec.js';
import { validateSpec } from '../../validateSpec.js';
import type { NodeMap } from './common.js';

/** Every node type the engine knows. A helper must emit only these. */
export const ENGINE_NODE_TYPES = [
  'step',
  'agent',
  'mcp',
  'eval',
  'set',
  'cond',
  'signal',
  'terminate',
  'fanOut',
  'shell',
  'containerStep',
  'humanApproval',
  'humanDecision',
  'humanInput',
  'humanReview',
];

/**
 * Wrap a helper's output in a runnable spec so the real schema and validator
 * judge it: edges that leave the fragment get a stub terminate, `entry` is where
 * the fragment starts. Returns the validation report.
 */
export function checkFragment(nodes: NodeMap, entry: string, external: string[] = []) {
  const all: Record<string, Node> = { ...nodes };
  for (const id of external) {
    all[id] = { status: 'SUCCESS', type: 'terminate' };
  }
  const spec = WorkflowSpecSchema.parse({
    description: '',
    entry,
    name: 'fragment',
    nodes: all,
    schemaVersion: SPEC_SCHEMA_VERSION,
  });
  return { report: validateSpec(spec), spec };
}

/** The ids a fragment's edges point at that the fragment does not define itself. */
export function danglingTargets(nodes: NodeMap): string[] {
  const out = new Set<string>();
  for (const node of Object.values(nodes)) {
    for (const [, target] of nodeEdges(node)) {
      if (!(target in nodes)) {
        out.add(target);
      }
    }
  }
  return [...out].sort();
}

/** What every helper must satisfy: flat, known types only, grouped, no validator findings. */
export function expectWellFormed(nodes: NodeMap, entry: string, external: string[] = []) {
  for (const [id, node] of Object.entries(nodes)) {
    expect(ENGINE_NODE_TYPES, `${id} has type ${node.type}`).toContain(node.type);
    expect(node.group, `${id} should carry a group`).toBeTruthy();
    expect(node.title, `${id} should carry a title`).toBeTruthy();
  }
  expect(danglingTargets(nodes)).toEqual([...external].sort());
  const { report } = checkFragment(nodes, entry, external);
  expect(report.errors).toEqual([]);
  expect(report.warnings.map((w) => w.code)).toEqual([]);
}
