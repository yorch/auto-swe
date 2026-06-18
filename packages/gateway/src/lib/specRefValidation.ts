import type { PrismaClient } from '@auto-swe/shared';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Non-fatal save-time validation of a spec's `agent` / `mcp` node references.
 *
 * Walks the spec and checks that each `agent` node's `agentRef` resolves to an
 * active Agent (at some scope) and each `mcp` node's `connectionRef` resolves to
 * an active `mcp` Connection, returning human-readable **warnings** for any that
 * don't. It never throws and never blocks the save: boot validation
 * (`assertConfigReady`) is the only hard-fail surface — by design a bad/missing
 * ref must fail *that run's node*, not the whole worker, and authors should be
 * able to save a work-in-progress spec that references a not-yet-created agent.
 * This just surfaces the problem at edit time instead of mid-run.
 *
 * Existence-only (key/id active at some scope) — model/credential resolvability
 * is left to run-time `resolveAgent`, which produces the precise error there.
 */
export async function validateSpecRefs(
  prisma: PrismaClient,
  spec: WorkflowSpec
): Promise<string[]> {
  const warnings: string[] = [];
  const agentRefs: { id: string; key: string }[] = [];
  const mcpRefs: { id: string; connectionRef: string }[] = [];

  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'agent') {
      // agentRef is `<key>` (float) or `<key>@<version>` (pin) — the key is the lineage.
      agentRefs.push({ id, key: node.agentRef.split('@')[0] });
    } else if (node.type === 'mcp') {
      mcpRefs.push({ connectionRef: node.connectionRef, id });
    }
  }

  if (agentRefs.length > 0) {
    const keys = [...new Set(agentRefs.map((r) => r.key))];
    const found = await prisma.agent.findMany({
      select: { key: true },
      where: { isActive: true, key: { in: keys } },
    });
    const present = new Set(found.map((a) => a.key));
    for (const r of agentRefs) {
      if (!present.has(r.key)) {
        warnings.push(
          `Node '${r.id}': agent '${r.key}' has no active Agent at any scope — create it at /admin/agents/library or this node will fail at run time.`
        );
      }
    }
  }

  if (mcpRefs.length > 0) {
    // Connection.id is a UUID column; only query well-formed ids (a non-UUID ref
    // is itself a warning rather than a DB error).
    const ids = [...new Set(mcpRefs.map((r) => r.connectionRef).filter((id) => UUID_RE.test(id)))];
    const found =
      ids.length > 0
        ? await prisma.connection.findMany({
            select: { id: true },
            where: { id: { in: ids }, isActive: true, type: 'mcp' },
          })
        : [];
    const present = new Set(found.map((c) => c.id));
    for (const r of mcpRefs) {
      if (!present.has(r.connectionRef)) {
        warnings.push(
          `Node '${r.id}': mcp connection '${r.connectionRef}' is not an active mcp connection — create one at /admin/mcp-connections or this node will fail at run time.`
        );
      }
    }
  }

  return warnings;
}
