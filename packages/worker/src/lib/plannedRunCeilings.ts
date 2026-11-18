import { resolveSettings, SETTING_DEFINITIONS } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_MAX_WALL_CLOCK_SECONDS } from '@auto-swe/shared/lib/agentRun';
import { isPlannedRunTemplate } from '@auto-swe/shared/lib/plannedRun';
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
