/**
 * Worst-case node transitions of a set of nodes, for the shared transition cap.
 *
 * The interpreter counts every node entry of a run against one cap
 * ({@link DEFAULT_MAX_TRANSITIONS}) and throws when it is passed. A generated plan's pre-region
 * runs before the core, so a pre-region that burns most of the cap decides where the core dies:
 * after the pull request is open, with nothing to say so. The policy therefore bounds the whole
 * walk: pre-region, canonical core and post-region must fit together.
 *
 * The bound is an over-approximation that needs no simulation. A node that sits on no cycle is
 * entered at most once, because a walk that entered it twice would contain a cycle through it. A
 * node with `maxVisits` is entered at most `maxVisits + 1` times (the last entry is the one that is
 * routed to `onExhausted`, and it counts). A node on a cycle without its own `maxVisits` is
 * entered once, plus once for every closed walk through it, and each such walk contains an entry
 * of a bounded node of its component, so at most `1 + Σ (maxVisits + 1)` over the bounded nodes of
 * that component. A component with no bounded node is unbounded: the bound is `Infinity`.
 *
 * Pure and I/O-free.
 */

import { DEFAULT_MAX_TRANSITIONS } from '../interpreter.js';
import { type Node, nodeEdges } from '../spec.js';

/**
 * Headroom kept below the cap. The bound is already an upper bound; the margin covers an
 * operator who pinned a cap a little under the default's reach and node entries the policy does
 * not see (a router hop). `transitionBudget.test.ts` ties it to the core: the core plus this
 * margin leaves the free regions a usable budget, and the real interpreter stays under the bound.
 */
export const TRANSITION_MARGIN = 20;

/** What pre-region, core and post-region together may cost. */
export const TRANSITION_BUDGET = DEFAULT_MAX_TRANSITIONS - TRANSITION_MARGIN;

/**
 * An upper bound on how many times the interpreter enters the nodes `ids` of `nodes`, over any
 * walk through them. `Infinity` when a cycle has no `maxVisits` anywhere on it.
 */
export function worstCaseTransitions(
  nodes: Readonly<Record<string, Node>>,
  ids: Iterable<string>
): number {
  const inSet = new Set(ids);
  const adj = new Map<string, string[]>();
  for (const id of inSet) {
    const node = nodes[id];
    adj.set(
      id,
      node === undefined ? [] : nodeEdges(node).flatMap(([, to]) => (inSet.has(to) ? [to] : []))
    );
  }
  // Tarjan's strongly connected components, iterative so a long chain cannot overflow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  const members: string[][] = [];
  let counter = 0;
  for (const root of inSet) {
    if (index.has(root)) {
      continue;
    }
    const work: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; next: number };
      const edges = adj.get(frame.id) as string[];
      if (frame.next < edges.length) {
        const to = edges[frame.next++] as string;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter++;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(to) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        let member: string;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.set(member, members.length);
          group.push(member);
        } while (member !== frame.id);
        members.push(group);
      }
    }
  }
  const visits = (id: string): number => {
    const max = nodes[id]?.maxVisits;
    return max === undefined ? Number.POSITIVE_INFINITY : max + 1;
  };
  let total = 0;
  for (const id of inSet) {
    const own = visits(id);
    if (own !== Number.POSITIVE_INFINITY) {
      total += own;
      continue;
    }
    const group = members[component.get(id) as number] as string[];
    const cyclic = group.length > 1 || (adj.get(id) as string[]).includes(id);
    if (!cyclic) {
      total += 1;
      continue;
    }
    const bounded = group.map(visits).filter((v) => v !== Number.POSITIVE_INFINITY);
    if (bounded.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    total += 1 + bounded.reduce((a, b) => a + b, 0);
  }
  return total;
}
