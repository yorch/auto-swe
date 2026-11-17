import { AGENT_REF_RE, NON_LAUNCHABLE_AGENT_KEYS } from '@auto-swe/shared/lib/agentRun';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { agentScopeBranches } from './agentRunLaunch.js';

/**
 * The keys of the library agents launchable for a repository of `orgId`: active, not on
 * `NON_LAUNCHABLE_AGENT_KEYS`, and expressible in the launch grammar. This is the set a plan's
 * `agent` nodes may name; it is computed on the server and never taken from a request.
 */
export async function launchableAgentKeys(
  prisma: FastifyInstance['prisma'],
  orgId: string | null
): Promise<string[]> {
  const rows = await runUnscoped(
    'an agent run resolves its agent at GLOBAL and ORGANIZATION scope only',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        orderBy: [{ key: 'asc' }],
        select: { key: true },
        where: {
          isActive: true,
          key: { notIn: [...NON_LAUNCHABLE_AGENT_KEYS] },
          // With no organization there is nothing to match beyond GLOBAL.
          OR: orgId ? agentScopeBranches(orgId) : agentScopeBranches(orgId).slice(0, 1),
        },
      })
  );
  // A key the launch grammar cannot express (a bundle-installed one may be) would be offered and
  // then refused; the picker filters the same way.
  return [...new Set(rows.map((r) => r.key).filter((k) => AGENT_REF_RE.test(k)))];
}
