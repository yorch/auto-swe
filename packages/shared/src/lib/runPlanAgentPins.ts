/**
 * The agent versions a run plan was built against, and the same lookup run again later.
 *
 * A pin is `<scope>:<version>` per agent ref, e.g. `{ implementer: 'GLOBAL:3' }`: the scope that
 * wins the cascade for the run and the highest active version at that scope. Recording the scope as
 * well as the version is what makes a team, organisation or template override that appears after
 * the plan was built a drift: the version number alone would still match.
 *
 * Same cascade the worker's `resolveAgent` walks for a run (WORKFLOW_TEMPLATE, TEAM, ORGANIZATION,
 * then GLOBAL; a planned run has no channel). The WORKFLOW_TEMPLATE tier is the Planned Run
 * template's own id, which the validator accepts as a scope for an agent. The gateway and the
 * worker both call this, so what approval checks and what the worker re-checks at pin time cannot
 * mean different things.
 *
 * Three things beyond a plain key lookup:
 *
 * - **Which agents.** {@link specAgentKeys} returns the refs of the spec's `agent` nodes AND the
 *   agents its `step` nodes resolve (`RUN_PLAN_STEP_AGENTS`), because the canonical core is made
 *   of steps.
 * - **Pinned refs.** A node `key@N` runs version N of the GLOBAL row (a scoped override still
 *   wins, as at run time), so its pin is keyed by the full ref and the GLOBAL tier looks for
 *   exactly version N. A version that is gone or inactive resolves to `null`: drift.
 * - **Inherited models.** A persona without its own model runs on its parent's, so the parent is
 *   pinned too, resolved through the same cascade, as a plain key.
 */

import { runPlanStepAgentKeys } from './runPlanStepAgents.js';

export type RunPlanAgentPins = Record<string, string>;

interface AgentPinRow {
  scope: string;
  version: number;
  /** Absent on a stand-in that does not model inheritance. */
  modelSpec?: string | null;
  inheritsModelFrom?: string | null;
}

/** The slice of the Prisma client the lookup reads, so a test can pass a stand-in. */
export interface AgentPinReader {
  agent: {
    findFirst(args: {
      orderBy: { version: 'desc' };
      select: {
        scope: true;
        version: true;
        modelSpec: true;
        inheritsModelFrom: true;
      };
      where: Record<string, unknown>;
    }): Promise<AgentPinRow | null>;
  };
}

export interface RunPlanAgentScope {
  teamId?: string | null;
  orgId?: string | null;
  /** The Planned Run template's id: the WORKFLOW_TEMPLATE tier of the cascade. */
  workflowTemplateId?: string | null;
}

/** Longest `inheritsModelFrom` chain followed; a longer one is a cycle or a misconfiguration. */
const MAX_INHERIT_DEPTH = 8;

/** `<key>` or `<key>@<version>` (version a positive integer); `null` for anything else. */
export function parseAgentPinRef(ref: string): { key: string; version?: number } | null {
  const at = ref.lastIndexOf('@');
  if (at === -1) {
    return ref ? { key: ref } : null;
  }
  const key = ref.slice(0, at);
  const raw = ref.slice(at + 1);
  const version = Number(raw);
  if (!key || !/^\d+$/.test(raw) || !Number.isInteger(version) || version < 1) {
    return null;
  }
  return { key, version };
}

/**
 * The pin of every ref, plus one for each parent a persona inherits its model from. `null` for a
 * ref with no active agent at any tier (or a pinned version that is gone): such a plan cannot be
 * approved or run.
 */
export async function resolveRunPlanAgentPins(
  db: AgentPinReader,
  refs: readonly string[],
  scope: RunPlanAgentScope
): Promise<Record<string, string | null>> {
  const pins: Record<string, string | null> = {};

  const lookup = async (key: string, version: number | undefined): Promise<AgentPinRow | null> => {
    const tiers: Array<Record<string, unknown>> = [];
    if (scope.workflowTemplateId) {
      tiers.push({
        isActive: true,
        key,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: scope.workflowTemplateId,
      });
    }
    if (scope.teamId) {
      tiers.push({ isActive: true, key, scope: 'TEAM', teamId: scope.teamId });
    }
    if (scope.orgId) {
      tiers.push({ isActive: true, key, orgId: scope.orgId, scope: 'ORGANIZATION' });
    }
    // The explicit version applies to the GLOBAL row only, as in `agentResolver`.
    tiers.push({
      isActive: true,
      key,
      scope: 'GLOBAL',
      ...(version !== undefined ? { version } : {}),
    });
    for (const where of tiers) {
      const row = await db.agent.findFirst({
        orderBy: { version: 'desc' },
        select: { inheritsModelFrom: true, modelSpec: true, scope: true, version: true },
        where,
      });
      if (row) {
        return row;
      }
    }
    return null;
  };

  const pinOne = async (name: string, key: string, version: number | undefined, depth: number) => {
    if (Object.hasOwn(pins, name)) {
      return;
    }
    const row = await lookup(key, version);
    pins[name] = row ? `${row.scope}:${row.version}` : null;
    // A persona with no model of its own runs on its parent's: that row is part of the call.
    if (row && !row.modelSpec && row.inheritsModelFrom && depth < MAX_INHERIT_DEPTH) {
      await pinOne(row.inheritsModelFrom, row.inheritsModelFrom, undefined, depth + 1);
    }
  };

  for (const ref of [...new Set(refs)].sort()) {
    const parsed = parseAgentPinRef(ref);
    if (!parsed) {
      pins[ref] = null;
      continue;
    }
    await pinOne(ref, parsed.key, parsed.version, 0);
  }
  return pins;
}

/**
 * Keys in `recorded` whose pin is not what `current` resolves now (a version bump, a new or
 * removed override, an agent that is gone), keys `required` names that `recorded` lacks, and keys
 * `current` resolved (a parent the plan never pinned) that `recorded` lacks. Empty means the
 * plan's agents are exactly as they were.
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
  for (const key of Object.keys(current)) {
    if (!(key in rec)) {
      drift.add(key);
    }
  }
  return [...drift].sort();
}

/**
 * The agent refs `spec` runs: its `agent` nodes' refs as written (`key` or `key@N`) and the agents
 * every `step` node resolves. This is `required` for {@link agentPinDrift}, and what a generator
 * passes to {@link resolveRunPlanAgentPins} to build `RunPlan.agentPins`.
 */
export function specAgentKeys(spec: { nodes?: Record<string, unknown> }): string[] {
  const keys = new Set<string>();
  for (const node of Object.values(spec.nodes ?? {})) {
    const n = node as { type?: unknown; agentRef?: unknown; step?: unknown };
    if (n.type === 'agent' && typeof n.agentRef === 'string') {
      keys.add(n.agentRef);
    } else if (n.type === 'step' && typeof n.step === 'string') {
      for (const key of runPlanStepAgentKeys(n.step)) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}
