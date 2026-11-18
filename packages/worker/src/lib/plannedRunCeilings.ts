import { resolveSettings, SETTING_DEFINITIONS } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_MAX_WALL_CLOCK_SECONDS } from '@auto-swe/shared/lib/agentRun';
import { isPlannedRunTemplate } from '@auto-swe/shared/lib/plannedRun';
import { Context } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import type { ResolveCtx } from './config/types.js';
import { getErrorMessage } from './errors.js';

/**
 * The ceilings an `agent` node of a planned run obeys: the same two settings an agent run clamps
 * to, because a generated plan's agent nodes have no step or time fields of their own.
 *
 * Decided and read inside the activity, never in workflow code (the isolate cannot read the
 * database and a replay must not take another path).
 */
export interface PlannedRunCeilings {
  maxSteps: number;
  maxWallClockSeconds: number;
}

/** Hard maxima of the two registry definitions (`positiveInt.max(500)` and the 4 h bound). */
const MAX_STEPS_HARD = 500;

function defaults(): PlannedRunCeilings {
  return {
    maxSteps: SETTING_DEFINITIONS['workspace.agentRunMaxSteps'].defaultValue,
    maxWallClockSeconds: SETTING_DEFINITIONS['workspace.agentRunMaxWallClockSeconds'].defaultValue,
  };
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

/**
 * Whether the run this activity belongs to is a planned run: its template is the hidden Planned
 * Run system template (reserved origin, no owning team). Read from the template row the run was
 * created under, never from the spec, the node or the trigger label, none of which a plan can
 * decide or which the run's behaviour may depend on.
 */
export async function isPlannedRunContext(ctx: ResolveCtx): Promise<boolean> {
  if (!ctx.workflowTemplateId) {
    return false;
  }
  const template = await prisma.workflowTemplate.findUnique({
    select: { origin: true, teamId: true },
    where: { id: ctx.workflowTemplateId },
  });
  return template !== null && isPlannedRunTemplate(template);
}

/**
 * The ceilings in force for a planned run, resolved at the run's owning team and organization
 * only (the template can never override a ceiling, as for agent runs). A failed read yields the
 * registry defaults, never "no limit", and a value is clamped to the registry's hard maximum.
 */
export async function resolvePlannedRunCeilings(ctx: ResolveCtx): Promise<PlannedRunCeilings> {
  const fallback = defaults();
  try {
    const settings = await resolveSettings(
      ['workspace.agentRunMaxSteps', 'workspace.agentRunMaxWallClockSeconds'],
      { orgId: ctx.orgId, teamId: ctx.teamId }
    );
    return {
      maxSteps: bounded(
        settings['workspace.agentRunMaxSteps'],
        fallback.maxSteps,
        1,
        MAX_STEPS_HARD
      ),
      maxWallClockSeconds: bounded(
        settings['workspace.agentRunMaxWallClockSeconds'],
        fallback.maxWallClockSeconds,
        60,
        AGENT_RUN_MAX_WALL_CLOCK_SECONDS
      ),
    };
  } catch (err) {
    logWarn('planned run ceilings unreadable; using the registry defaults', {
      error: getErrorMessage(err),
    });
    return fallback;
  }
}

/**
 * Time kept back from the activity's own `startToCloseTimeout` for what must still run after the
 * loop is aborted: billing the aborted step, persisting the trace (`finally`), closing the harness
 * session and tearing the workspace down.
 */
export const ACTIVITY_SLACK_SECONDS = 90;
/** The shortest deadline worth starting a loop for; with less budget left the node fails fast. */
export const MIN_EFFECTIVE_WALL_CLOCK_SECONDS = 30;

/**
 * The practical maximum of a planned node is bounded by its activity timeout, whatever
 * `workspace.agentRunMaxWallClockSeconds` says: an `agent` node runs under a Temporal
 * `startToCloseTimeout` of 10 minutes (no workspace) or 30 minutes (workspace node), and that
 * timeout is RETRYABLE, so a deadline beyond it would be pre-empted by a retry that spends the
 * ceiling again. The deadline is therefore clamped to what the activity can still afford, which
 * is about 8.5 minutes without a workspace and about 28.5 with one, less the time already spent
 * (workspace setup). The activity options live in `workflows/runnableActivities.ts` and are not
 * changed from here.
 */
export interface EffectiveDeadline {
  /** The deadline to arm; 0 when `exhausted`. */
  effectiveSeconds: number;
  /** The activity's total start-to-close budget, or null when there is no Temporal context. */
  activityBudgetSeconds: number | null;
  /** The activity budget (not the setting) is what limited the deadline. */
  clamped: boolean;
  /** Too little budget is left to run a loop that can finish: fail fast. */
  exhausted: boolean;
}

/**
 * `effective = min(configured, floor(activityTimeout - elapsed - ACTIVITY_SLACK_SECONDS))`.
 * When that second term is below MIN_EFFECTIVE_WALL_CLOCK_SECONDS the node is `exhausted` (no
 * loop is started), so the effective deadline is never below the minimum. Without an activity
 * timeout the configured value is used as is.
 */
export function effectiveWallClock(args: {
  configuredSeconds: number;
  activityTimeoutMs: number | undefined;
  elapsedMs: number;
}): EffectiveDeadline {
  const { configuredSeconds, activityTimeoutMs } = args;
  if (!activityTimeoutMs || !Number.isFinite(activityTimeoutMs) || activityTimeoutMs <= 0) {
    return {
      activityBudgetSeconds: null,
      clamped: false,
      effectiveSeconds: configuredSeconds,
      exhausted: false,
    };
  }
  const budgetSeconds = Math.floor(activityTimeoutMs / 1000);
  const room = Math.floor(
    (activityTimeoutMs - Math.max(0, args.elapsedMs)) / 1000 - ACTIVITY_SLACK_SECONDS
  );
  if (room < MIN_EFFECTIVE_WALL_CLOCK_SECONDS) {
    return {
      activityBudgetSeconds: budgetSeconds,
      clamped: true,
      effectiveSeconds: 0,
      exhausted: true,
    };
  }
  return {
    activityBudgetSeconds: budgetSeconds,
    clamped: room < configuredSeconds,
    effectiveSeconds: Math.min(configuredSeconds, room),
    exhausted: false,
  };
}

/**
 * The running activity's `startToCloseTimeout` in ms, or undefined outside a Temporal activity
 * (unit tests) or when the info lacks one. The seam for tests is `Context.current`.
 */
export function currentActivityTimeoutMs(): number | undefined {
  try {
    const ms = Context.current().info.startToCloseTimeoutMs;
    return typeof ms === 'number' && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}
