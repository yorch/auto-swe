/**
 * How a node is named on screen.
 *
 * A node's id is its identity in the spec (edges, analytics and run history all
 * key on it) and is often terse or mechanical (`updateCodeAfterReviewFix`). A
 * node may also carry a short `title` and a `group` label, both presentation-only.
 * Every surface that names a node — the canvas card, the outline, an aria label —
 * goes through here so they agree: the title when there is one, the id otherwise.
 *
 * The four human nodes have always carried a required `title` (the approver's
 * inbox heading), so they read by it too.
 */
import type { Node as SpecNode } from '@auto-swe/shared/workflow';

/** The name to show for a node: its title if it has one, else its id. */
export function nodeDisplayName(node: SpecNode | undefined, id: string): string {
  const title = node && 'title' in node && typeof node.title === 'string' ? node.title.trim() : '';
  return title || id;
}

/** True when the node is shown by a title, so the id is not what the reader sees. */
export function hasDisplayTitle(node: SpecNode | undefined, id: string): boolean {
  return nodeDisplayName(node, id) !== id;
}

/** The node's group label, if it has one. */
export function nodeGroupOf(node: SpecNode | undefined): string | undefined {
  const group = node && typeof node.group === 'string' ? node.group.trim() : '';
  return group || undefined;
}

const STOP_STATUS_WORD: Record<string, string> = {
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  SUCCESS: 'SUCCESS',
  TIMED_OUT: 'TIMED OUT',
};

function stopChip(prefix: string, route: unknown): string | undefined {
  if (typeof route !== 'object' || route === null) {
    return undefined;
  }
  const status = (route as { status?: string }).status ?? '';
  return `${prefix}: stop ${STOP_STATUS_WORD[status] ?? status}`;
}

/**
 * The plain-text notes a card shows for the optional flow fields: the domain
 * `status` it sets, its visit limit, and the stop-the-run shorthands (which have
 * no target node and so draw no edge). A `terminate` node's `status` is its
 * terminal status and already its sublabel, so it is not repeated.
 */
export function nodeFlowNotes(node: SpecNode | undefined): {
  status?: string;
  maxVisits?: string;
  chips: string[];
} {
  if (!node) {
    return { chips: [] };
  }
  const r = node as unknown as Record<string, unknown>;
  const status = node.type !== 'terminate' && typeof r.status === 'string' ? r.status : undefined;
  const maxVisits =
    typeof r.maxVisits === 'number'
      ? `max ${r.maxVisits} ${r.maxVisits === 1 ? 'visit' : 'visits'}`
      : undefined;
  const chips = [stopChip('on failure', r.onFailure), stopChip('out of attempts', r.onExhausted)];
  return { chips: chips.filter((c): c is string => c !== undefined), maxVisits, status };
}
