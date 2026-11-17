/**
 * The agent versions a run plan was built against, and the same lookup run again later.
 *
 * A pin is `<scope>:<version>` per agent key, e.g. `{ implementer: 'GLOBAL:3' }`: the scope that
 * wins the cascade for the run's team and organisation, and the highest active version at that
 * scope. Recording the scope as well as the version is what makes a team or organisation override
 * that appears after the plan was built a drift: the version number alone would still match.
 *
 * Same cascade the worker's `resolveAgent` walks for a run (TEAM, ORGANIZATION, then GLOBAL). A
 * planned run has no channel and its template has no template-scoped agents, so those two tiers
 * are not consulted. The gateway and the worker both call this, so what approval checks and what
 * the worker re-checks at pin time cannot mean different things.
 */

export type RunPlanAgentPins = Record<string, string>;

/** The slice of the Prisma client the lookup reads, so a test can pass a stand-in. */
export interface AgentPinReader {
  agent: {
    findFirst(args: {
      orderBy: { version: 'desc' };
      select: { scope: true; version: true };
      where: Record<string, unknown>;
    }): Promise<{ scope: string; version: number } | null>;
  };
}

export interface RunPlanAgentScope {
  teamId?: string | null;
  orgId?: string | null;
}

/** `null` for a key with no active agent at any tier: such a plan cannot be approved or run. */
export async function resolveRunPlanAgentPins(
  db: AgentPinReader,
  keys: readonly string[],
  scope: RunPlanAgentScope
): Promise<Record<string, string | null>> {
  const pins: Record<string, string | null> = {};
  for (const key of [...new Set(keys)].sort()) {
    const tiers: Array<Record<string, unknown>> = [];
    if (scope.teamId) {
      tiers.push({ isActive: true, key, scope: 'TEAM', teamId: scope.teamId });
    }
    if (scope.orgId) {
      tiers.push({ isActive: true, key, orgId: scope.orgId, scope: 'ORGANIZATION' });
    }
    tiers.push({ isActive: true, key, scope: 'GLOBAL' });
    pins[key] = null;
    for (const where of tiers) {
      const row = await db.agent.findFirst({
        orderBy: { version: 'desc' },
        select: { scope: true, version: true },
        where,
      });
      if (row) {
        pins[key] = `${row.scope}:${row.version}`;
        break;
      }
    }
  }
  return pins;
}

/**
 * Keys in `recorded` whose pin is not what `current` resolves now (a version bump, a new or
 * removed override, an agent that is gone), plus keys `required` names that `recorded` lacks.
 * Empty means the plan's agents are exactly as they were.
 */
export function agentPinDrift(
  recorded: unknown,
  current: Record<string, string | null>,
  required: readonly string[] = []
): string[] {
  const rec =
    recorded && typeof recorded === 'object' && !Array.isArray(recorded)
      ? (recorded as Record<string, unknown>)
      : {};
  const drift = new Set<string>();
  for (const [key, pin] of Object.entries(rec)) {
    if (typeof pin !== 'string' || current[key] !== pin) {
      drift.add(key);
    }
  }
  for (const key of required) {
    if (!(key in rec)) {
      drift.add(key);
    }
  }
  return [...drift].sort();
}

/** The agent keys the nodes of `spec` name, for `required` above. */
export function specAgentKeys(spec: { nodes?: Record<string, unknown> }): string[] {
  const keys = new Set<string>();
  for (const node of Object.values(spec.nodes ?? {})) {
    const n = node as { type?: unknown; agentRef?: unknown };
    if (n.type === 'agent' && typeof n.agentRef === 'string') {
      // `<key>` or `<key>@<version>`.
      keys.add(n.agentRef.split('@')[0] as string);
    }
  }
  return [...keys].sort();
}
