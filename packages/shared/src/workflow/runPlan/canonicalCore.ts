/**
 * The canonical core of a delivering run plan.
 *
 * A generated plan is a canonical core with free ends. The core is the part of the shipped
 * `ticket-to-merge` graph that delivers: the implementation, the review loop, the pull request,
 * the CI loop, the lessons and the human merge wait. It is not described to the policy by rules
 * about what such a graph should do; it is BUILT, by the same function the template is built by
 * ({@link ticketToMergeCore}), and a generated plan's core nodes must equal it node for node.
 * That is the single source of truth: change the template's core and the pinned core moves with
 * it, and `canonicalCore.test.ts` fails if the two ever stop agreeing.
 *
 * Not part of the core, so the generator's to write (the "free ends"):
 *
 * - the **pre-region**: nodes that run before the core and hand over to {@link CORE_ENTRY}. In
 *   `ticket-to-merge` this is the validate phase (`gatherTicket`, `setTicket`, `validate`,
 *   `checkActionable`, `terminateNotActionable`, `setSuccessCriteria`).
 * - the **post-region**: nodes that run once a person has merged, hung off the merge wait through
 *   the one {@link CORE_HOOK} edge.
 *
 * Exactly two things in the core are not fixed:
 *
 * 1. the {@link CORE_HOOK} edge, `waitForHumanMerge.onReceive`, which is `commitLesson` in the
 *    canonical core and may be re-pointed at a post-region node;
 * 2. the {@link CORE_GUIDANCE_SLOT}, `implement.inputs.guidance`, which is absent in the shipped
 *    template and may be bound from `context.planNotes`, the one channel through which the
 *    pre-region reaches the implementer.
 *
 * Pure and I/O-free.
 */

import { type Node, NodeSchema } from '../spec.js';
import { ticketToMergeCore, ticketToMergeValidate } from '../templates/ticketToMerge.js';
import { PLAN_NOTES } from './skeletonBindings.js';

/** The node a pre-region hands over to: the only core node a free node may name. */
export const CORE_ENTRY = 'implement';

/** The id of the merge wait; the one core node with a mutable edge. */
export const CORE_MERGE_WAIT = 'waitForHumanMerge';

/**
 * The one mutable edge of the core. `canonical` is read from the built core (see
 * {@link buildCanonicalCore}); the policy accepts any free post-region node id in its place.
 */
export const CORE_HOOK = { field: 'onReceive', node: CORE_MERGE_WAIT } as const;

/** The context path through which the pre-region may give the implementer guidance. */
export const PLAN_NOTES_PATH = PLAN_NOTES;

/**
 * The one mutable input of the core: `implement.inputs.guidance` may be absent or exactly this.
 */
export const CORE_GUIDANCE_SLOT = {
  binding: { from: PLAN_NOTES_PATH },
  key: 'guidance',
  node: CORE_ENTRY,
} as const;

export interface CanonicalCore {
  /** The core's nodes by id, as flat plain nodes (no macro `use` tag). */
  nodes: Record<string, Node>;
  /** Where a pre-region hands over. */
  entry: typeof CORE_ENTRY;
  /** The node the hook edge points at in the canonical core, and where a post-region returns to. */
  hookTarget: string;
}

/** The core nodes' ids, in a stable order. */
export function canonicalCoreIds(): string[] {
  return Object.keys(buildCanonicalCore().nodes);
}

function stripUse(node: Node): Node {
  const { use: _use, ...rest } = node as Node & { use?: string };
  return rest as Node;
}

/**
 * A node as the spec parser reads it: schema defaults applied (`onError: 'fail'`, say), unknown
 * keys dropped. A generated spec has been through the parser and a template's TypeScript literal
 * has not, so both sides of a comparison go through it.
 */
function asParsed(node: Node): Node {
  const result = NodeSchema.safeParse(node);
  return result.success ? result.data : node;
}

/**
 * A fresh construction of the canonical core: `ticket-to-merge` with the uiVerify step, minus its
 * validate phase. Built on every call from the template's own builders, so a caller may mutate
 * the result.
 */
export function buildCanonicalCore(): CanonicalCore {
  const built = ticketToMergeCore(CORE_MERGE_WAIT, { uiVerify: true });
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(built.nodes)) {
    nodes[id] = asParsed(stripUse(structuredClone(node)));
  }
  const wait = nodes[CORE_MERGE_WAIT];
  if (wait?.type !== 'signal' || typeof wait.onReceive !== 'string') {
    throw new Error('the canonical core has no merge wait with an onReceive edge');
  }
  return { entry: CORE_ENTRY, hookTarget: wait.onReceive, nodes };
}

/** The node the shipped validate phase starts at. */
export const VALIDATE_ENTRY = 'gatherTicket';

/**
 * The shipped validate phase of `ticket-to-merge`, as flat free nodes that hand over to
 * {@link CORE_ENTRY}. Not part of the core: `applySkeletonPolicy` attaches it ahead of the core when
 * a pre-region runs no `validateContext` step, because a delivering plan must validate.
 */
export function buildValidatePhase(): Record<string, Node> {
  const built = ticketToMergeValidate();
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(built.nodes)) {
    nodes[id] = asParsed(stripUse(structuredClone(node)));
  }
  return nodes;
}

/** Key-order-insensitive JSON, for comparing two nodes. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * A spec node reduced to the form it is compared in: no `use` tag, the hook edge replaced by the
 * canonical value when it names a node outside the core, the guidance slot dropped when it holds
 * exactly the planNotes binding. What is left must equal the canonical node.
 */
export function normalizeCoreNode(
  id: string,
  node: Node,
  core: CanonicalCore,
  coreIds: ReadonlySet<string>,
  specHas: (id: string) => boolean
): Node {
  const copy = structuredClone(stripUse(node)) as Node & Record<string, unknown>;
  if (id === CORE_ENTRY) {
    const inputs = copy.inputs as Record<string, unknown> | undefined;
    if (
      inputs !== undefined &&
      typeof inputs === 'object' &&
      sameJson(inputs[CORE_GUIDANCE_SLOT.key], CORE_GUIDANCE_SLOT.binding)
    ) {
      delete inputs[CORE_GUIDANCE_SLOT.key];
    }
  }
  if (id === CORE_HOOK.node) {
    const target = copy[CORE_HOOK.field];
    if (typeof target === 'string' && !coreIds.has(target) && specHas(target)) {
      copy[CORE_HOOK.field] = core.hookTarget;
    }
  }
  return asParsed(copy as Node);
}
