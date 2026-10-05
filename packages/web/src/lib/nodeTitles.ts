/**
 * The titles a workflow spec gives its nodes, keyed by node id. A spec's `nodes` is a
 * record of id → node and a node's `title` is optional, so only titled nodes appear;
 * use `nodeLabel` to fall back to something readable.
 */
export function nodeTitlesOf(spec: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const nodes = (spec as { nodes?: unknown } | null | undefined)?.nodes;
  if (nodes && typeof nodes === 'object') {
    for (const [id, node] of Object.entries(nodes)) {
      const title = (node as { title?: unknown } | null)?.title;
      if (typeof title === 'string' && title.trim()) {
        titles.set(id, title.trim());
      }
    }
  }
  return titles;
}
