import { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { type ImplementerRuntimeKind, toImplementerRuntime } from '@auto-swe/shared/types/api';
import { activityInfo, asyncLocalStorage } from '@temporalio/activity';
import { resolveAgent } from './agentResolver.js';
import type { ResolveCtx } from './types.js';

/**
 * Where an agent's runtime came from:
 *  - `run`: pinned for this run — by an earlier resolution (another activity, an
 *    earlier attempt) or by the caller (`ctx.agentRuntimes`, an eval case's override);
 *  - `agent`: the resolved Agent version (or the parent it inherits its model from) set one;
 *  - `default`: neither, so the caller's default applied.
 */
export type AgentRuntimeSource = 'run' | 'agent' | 'default';

export interface ResolvedAgentRuntime {
  runtime: ImplementerRuntimeKind;
  source: AgentRuntimeSource;
}

/**
 * What an agent with no runtime of its own runs on. The implementer family
 * follows the run-pinned `workspace.implementerRuntime` setting, as it always
 * has; an agent run has never read that setting, so it stays on Mastra unless
 * the Agent itself asks for the harness.
 */
export type AgentRuntimeDefault = 'implementerSetting' | 'mastra';

/**
 * The loop that drives `agentKey` in this run.
 *
 * The Agent version decides when it has an opinion (`Agent.runtime`, inherited
 * along `inheritsModelFrom`), resolved through the same cascade and agent-version
 * pin as its model; otherwise `fallback` does.
 *
 * Inside a run the answer is pinned on `WorkflowRun.agentRuntimes`: at run
 * start for every agent the run can resolve (`snapshotAgentRuntimes`, where
 * `null` records that the Agent had no opinion, so the default decides), and
 * otherwise the first time the run resolves it. Every later resolution —
 * another activity, a retry, a parallel branch — reads the pin. The agent-version pin alone cannot promise
 * that: it freezes the GLOBAL row only, so a TEAM or template override edited
 * mid-run would otherwise move a running agent onto the other loop. Outside a
 * run (the eval harness, tests) nothing is pinned and the value resolves live.
 *
 * A caller-supplied pin (`ctx.agentRuntimes`) comes first of all and is never
 * written back: it is how an eval case runs a side on the runtime its eval run
 * asked for, over the Agent's own choice, without a parameter that skips the
 * resolution.
 */
export async function resolveAgentRuntime(
  agentKey: string,
  ctx: ResolveCtx | undefined,
  fallback: AgentRuntimeDefault
): Promise<ResolvedAgentRuntime> {
  const supplied = toImplementerRuntime(ctx?.agentRuntimes?.[agentKey]);
  if (supplied) {
    return { runtime: supplied, source: 'run' };
  }
  const workflowId = ambientWorkflowId();
  if (workflowId) {
    const pinned = await readPin(workflowId, agentKey);
    if (pinned === 'no-opinion') {
      // The run started with the Agent having no runtime of its own: the default
      // decides, whatever the Agent says now.
      return { runtime: await defaultRuntime(fallback, ctx), source: 'default' };
    }
    if (pinned) {
      return { runtime: pinned, source: 'run' };
    }
  }

  const { runtime: own } = await resolveAgent(agentKey, ctx);
  const resolved: ResolvedAgentRuntime = own
    ? { runtime: own, source: 'agent' }
    : { runtime: await defaultRuntime(fallback, ctx), source: 'default' };
  if (!workflowId) {
    return resolved;
  }
  const pinned = await pinAgentRuntime(workflowId, agentKey, resolved.runtime);
  // A concurrent resolution pinned first: its answer is the run's.
  return pinned === resolved.runtime ? resolved : { runtime: pinned, source: 'run' };
}

async function defaultRuntime(
  fallback: AgentRuntimeDefault,
  ctx: ResolveCtx | undefined
): Promise<ImplementerRuntimeKind> {
  if (fallback === 'mastra') {
    return 'mastra';
  }
  // The setting's schema is `z.enum(IMPLEMENTER_RUNTIMES)` and the resolver degrades a
  // stored value that fails it, so this only narrows the type.
  const setting = await resolveSetting('workspace.implementerRuntime', ctx);
  return toImplementerRuntime(setting) ?? 'mastra';
}

/** The workflow id of the activity this runs in, or undefined outside one. */
function ambientWorkflowId(): string | undefined {
  if (!asyncLocalStorage.getStore()) {
    return undefined;
  }
  return activityInfo().workflowExecution?.workflowId;
}

function asRuntimeMap(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The run's pin for `agentKey`: a runtime; `'no-opinion'` when the run-start
 * snapshot recorded the Agent had none (`null`); undefined when the key is not
 * pinned yet (an agent created after the run started, a run from before the
 * snapshot existed) or holds a value this code does not know.
 */
async function readPin(
  workflowId: string,
  agentKey: string
): Promise<ImplementerRuntimeKind | 'no-opinion' | undefined> {
  const row = await prisma.workflowRun.findUnique({
    select: { agentRuntimes: true },
    where: { workflowId },
  });
  const map = asRuntimeMap(row?.agentRuntimes);
  if (map && agentKey in map && map[agentKey] === null) {
    return 'no-opinion';
  }
  return toImplementerRuntime(map?.[agentKey]) ?? undefined;
}

/**
 * Pin `candidate` as `agentKey`'s runtime for the run unless one is already
 * pinned, and return the pinned value. A compare-and-set on the whole map, so
 * two activities pinning different keys at once cannot drop each other's entry
 * and two pinning the same key agree on the first. A workflow with no run row
 * (not a template run) has nothing to pin and keeps the candidate.
 */
export async function pinAgentRuntime(
  workflowId: string,
  agentKey: string,
  candidate: ImplementerRuntimeKind
): Promise<ImplementerRuntimeKind> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await prisma.workflowRun.findUnique({
      select: { agentRuntimes: true, id: true },
      where: { workflowId },
    });
    if (!row) {
      return candidate;
    }
    const current = asRuntimeMap(row.agentRuntimes);
    const existing = toImplementerRuntime(current?.[agentKey]);
    if (existing) {
      return existing;
    }
    if (current && agentKey in current && current[agentKey] === null) {
      // Pinned at run start as no opinion: the caller's default stands, unwritten.
      return candidate;
    }
    const { count } = await prisma.workflowRun.updateMany({
      data: { agentRuntimes: { ...current, [agentKey]: candidate } as Prisma.InputJsonObject },
      where: {
        agentRuntimes: current
          ? { equals: current as Prisma.InputJsonObject }
          : { equals: Prisma.DbNull },
        id: row.id,
      },
    });
    if (count > 0) {
      return candidate;
    }
  }
  // Retryable: the map kept changing underneath; the next attempt reads it afresh.
  throw new Error(`could not pin the runtime of agent '${agentKey}' on run ${workflowId}`);
}
