import type { PrismaClient } from '@auto-swe/shared';
import { templateReachesConnection } from '@auto-swe/shared/lib/repoMembership';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Non-fatal save-time validation of a spec's `agent` / `mcp` / `eval` node references.
 *
 * Walks the spec and checks that each `agent` node's `agentRef` resolves to an
 * active Agent (at some scope), each `mcp` node's `connectionRef` resolves to
 * an active `mcp` Connection, and each `eval` judge scorer's `rubricRef` names an
 * `EvalRubric` slug, returning human-readable **warnings** for any that don't.
 * It never throws and never blocks the save: boot validation
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
  spec: WorkflowSpec,
  /** The template's team, so a literal `mcp` reference can be checked for reach. */
  templateTeamId: string | null
): Promise<string[]> {
  return (await findSpecRefProblems(prisma, spec, templateTeamId)).map((p) => p.message);
}

/** One unresolved reference, located on its node. */
export interface SpecRefProblem {
  code:
    | 'AGENT_REF_UNRESOLVED'
    | 'MCP_REF_NOT_REACHABLE'
    | 'MCP_REF_UNRESOLVED'
    | 'RUBRIC_REF_UNRESOLVED';
  nodeId: string;
  field: 'agentRef' | 'connectionRef' | `scorers[${number}].rubricRef`;
  message: string;
}

/**
 * The structured form of `validateSpecRefs` (which returns only the messages): the same lookups
 * and the same text, with the node and field kept so a caller can point at them.
 */
export async function findSpecRefProblems(
  prisma: PrismaClient,
  spec: WorkflowSpec,
  /** The template's team, so a literal `mcp` reference can be checked for reach. */
  templateTeamId: string | null
): Promise<SpecRefProblem[]> {
  const warnings: SpecRefProblem[] = [];
  const agentRefs: { id: string; key: string }[] = [];
  const mcpRefs: { id: string; connectionRef: string }[] = [];
  const rubricRefs: { id: string; index: number; slug: string }[] = [];

  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'agent') {
      // agentRef is `<key>` (float) or `<key>@<version>` (pin) — the key is the lineage.
      agentRefs.push({ id, key: node.agentRef.split('@')[0] });
    } else if (node.type === 'mcp') {
      mcpRefs.push({ connectionRef: node.connectionRef, id });
    } else if (node.type === 'eval') {
      node.scorers.forEach((scorer, index) => {
        if (scorer.kind === 'judge') {
          rubricRefs.push({ id, index, slug: scorer.rubricRef });
        }
      });
    }
  }

  if (agentRefs.length > 0) {
    const keys = [...new Set(agentRefs.map((r) => r.key))];
    // Cross-scope on purpose: the warning below is precisely "no active Agent
    // at ANY scope", so a team-filtered lookup would warn about agents that do
    // resolve at run time through the cascade.
    const found = await runUnscoped('agent keys resolve across every scope', ['Agent'], () =>
      prisma.agent.findMany({ select: { key: true }, where: { isActive: true, key: { in: keys } } })
    );
    const present = new Set(found.map((a) => a.key));
    for (const r of agentRefs) {
      if (!present.has(r.key)) {
        warnings.push({
          code: 'AGENT_REF_UNRESOLVED',
          field: 'agentRef',
          message: `Node '${r.id}': agent '${r.key}' has no active Agent at any scope — create it at /studio/agents/library or this node will fail at run time.`,
          nodeId: r.id,
        });
      }
    }
  }

  if (mcpRefs.length > 0) {
    // Connection.id is a UUID column; only query well-formed ids (a non-UUID ref
    // is itself a warning rather than a DB error).
    const ids = [...new Set(mcpRefs.map((r) => r.connectionRef).filter((id) => UUID_RE.test(id)))];
    const found =
      ids.length > 0
        ? await runUnscoped('existence check on author-supplied UUIDs', ['Connection'], () =>
            prisma.connection.findMany({
              select: { id: true, shares: { select: { teamId: true } }, teamId: true },
              where: { id: { in: ids }, isActive: true, type: 'mcp' },
            })
          )
        : [];
    const byId = new Map(found.map((c) => [c.id, c]));
    for (const r of mcpRefs) {
      const connection = byId.get(r.connectionRef);
      if (!connection) {
        warnings.push({
          code: 'MCP_REF_UNRESOLVED',
          field: 'connectionRef',
          message: `Node '${r.id}': mcp connection '${r.connectionRef}' is not an active mcp connection — create one at /studio/mcp or this node will fail at run time.`,
          nodeId: r.id,
        });
        continue;
      }
      // The connection exists, but a team's template may use only a connection that
      // team owns or has been shared with it: a literal reference is not a licence to
      // spend another team's token. Global templates are admin-authored and may use
      // any (see `templateReachesConnection`).
      if (!templateReachesConnection(connection, templateTeamId)) {
        warnings.push({
          code: 'MCP_REF_NOT_REACHABLE',
          field: 'connectionRef',
          message: `Node '${r.id}': mcp connection '${r.connectionRef}' does not belong to this template's team and is not shared with it — this node will be refused at run time.`,
          nodeId: r.id,
        });
      }
    }
  }

  if (rubricRefs.length > 0) {
    const slugs = [...new Set(rubricRefs.map((r) => r.slug))];
    // Cross-scope, like the judge's own run-time lookup: it reads the newest
    // version of the slug at any scope, matching the exact string — so a
    // `slug@version` spelling never resolves and is worth a warning too.
    const found = await runUnscoped('rubric slugs resolve across every scope', ['EvalRubric'], () =>
      prisma.evalRubric.findMany({ select: { slug: true }, where: { slug: { in: slugs } } })
    );
    const present = new Set(found.map((r) => r.slug));
    for (const r of rubricRefs) {
      if (!present.has(r.slug)) {
        warnings.push({
          code: 'RUBRIC_REF_UNRESOLVED',
          field: `scorers[${r.index}].rubricRef`,
          message: `Node '${r.id}': rubric '${r.slug}' is not an eval rubric slug — ask an admin to create it, or this judge cannot score (and blocks the node when judgeAdvisory is false).`,
          nodeId: r.id,
        });
      }
    }
  }

  return warnings;
}
