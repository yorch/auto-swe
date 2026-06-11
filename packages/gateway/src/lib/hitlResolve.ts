import type { PrismaClient } from '@auto-swe/shared';
import { Prisma } from '@auto-swe/shared';
import { HITL_VALID_ACTIONS, type HitlKind } from '@auto-swe/shared/workflow/interpreter';

/**
 * Shared HITL resolve core, used by:
 *   - `routes/humanSteps.ts` — POST /inbox/:id/respond (the inbox UI)
 *   - `routes/slack.ts`      — `hitl_resolve` Block Kit button interactions
 *
 * Both entry points enforce the SAME authorization (team visibility via
 * {@link runVisibilityFilter}), the same action validation, the same atomic
 * PENDING→RESOLVED guard, and the same Temporal-signal-with-rollback semantics.
 * The HTTP wire contracts live in the callers; this module only returns a
 * typed result.
 */

export interface HitlActor {
  /** Platform user id (JWT `sub` / `User.id`). */
  sub: string;
  role: string;
}

export interface HitlResolveDeps {
  prisma: PrismaClient;
  temporal: {
    signalWorkflow(workflowId: string, signalName: string, args?: unknown[]): Promise<void>;
  };
  log: { error(obj: unknown, msg?: string): void };
}

export type HitlResolveErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_RESOLVED'
  | 'RUN_NOT_RUNNING'
  | 'UNKNOWN_KIND'
  | 'INVALID_ACTION'
  | 'SIGNAL_FAILED';

export type HitlResolveResult =
  | { ok: true; stepId: string; kind: string; title: string }
  | { ok: false; code: HitlResolveErrorCode; message: string };

/**
 * Visibility filter for human steps: ADMIN sees everything; everyone else
 * sees steps whose run belongs to a global template, a template owned by one
 * of their teams, or a work request touching a repo of one of their teams.
 */
export function runVisibilityFilter(user: HitlActor): Prisma.WorkflowHumanStepWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    run: {
      OR: [
        { template: { teamId: null } },
        { template: { team: { memberships: { some: { userId: user.sub } } } } },
        {
          workRequest: {
            activeWorkflows: {
              some: { repository: { team: { memberships: { some: { userId: user.sub } } } } },
            },
          },
        },
      ],
    },
  };
}

/**
 * Resolve a pending human step on behalf of `user`.
 *
 * Sequence (must stay in lock-step with what the inbox route promised):
 *   1. Visibility-scoped lookup (404-equivalent when not found / not visible)
 *   2. Optimistic PENDING + run-RUNNING checks
 *   3. Action validation against HITL_VALID_ACTIONS for the step kind
 *   4. Atomic PENDING→RESOLVED updateMany (the real concurrency guard)
 *   5. Temporal signal; on failure roll the row back to PENDING so the user
 *      can retry instead of stranding the run
 */
export async function resolveHitlStep(
  deps: HitlResolveDeps,
  stepId: string,
  action: string,
  value: unknown,
  user: HitlActor
): Promise<HitlResolveResult> {
  const { prisma, temporal, log } = deps;

  const step = await prisma.workflowHumanStep.findFirst({
    include: { run: { select: { status: true, workflowId: true } } },
    where: { id: stepId, ...runVisibilityFilter(user) },
  });
  if (!step) {
    return { code: 'NOT_FOUND', message: 'Human step not found', ok: false };
  }
  if (step.status !== 'PENDING') {
    return { code: 'ALREADY_RESOLVED', message: 'This step has already been resolved', ok: false };
  }
  if (step.run.status !== 'RUNNING') {
    return {
      code: 'RUN_NOT_RUNNING',
      message: 'The workflow run is no longer running',
      ok: false,
    };
  }

  // Validate action against step kind using the shared HITL_VALID_ACTIONS map.
  // The map is Record<HitlKind, …> so TypeScript enforces exhaustiveness whenever
  // a new kind is added to the interpreter — this file stays in sync automatically.
  const allowed = HITL_VALID_ACTIONS[step.kind as HitlKind];
  if (!allowed) {
    return { code: 'UNKNOWN_KIND', message: `Unknown step kind: ${step.kind}`, ok: false };
  }
  if (!allowed.includes(action)) {
    return {
      code: 'INVALID_ACTION',
      message: `Action '${action}' is not valid for ${step.kind} steps. Expected: ${allowed.join(' or ')}`,
      ok: false,
    };
  }

  const signalPayload = { action, resolvedBy: user.sub, value };

  // Atomic update — guards against concurrent resolve (race condition).
  // The prior status check is an optimistic fast-path; this is the real guard.
  const result = await prisma.workflowHumanStep.updateMany({
    data: {
      payload: signalPayload as Prisma.InputJsonValue,
      resolvedAt: new Date(),
      resolvedBy: user.sub,
      status: 'RESOLVED',
    },
    where: { id: step.id, status: 'PENDING' },
  });
  if (result.count === 0) {
    return { code: 'ALREADY_RESOLVED', message: 'This step has already been resolved', ok: false };
  }

  // Deliver the Temporal signal. The workflow only unblocks via this
  // signal — if it fails after the row was marked RESOLVED, the step
  // would vanish from the inbox while the workflow stays stuck until its
  // timeout. Roll the row back to PENDING on failure so the user can
  // retry instead of stranding the run.
  try {
    await temporal.signalWorkflow(step.run.workflowId, step.signalName, [signalPayload]);
  } catch (err: unknown) {
    log.error({ err, stepId: step.id }, 'HITL Temporal signal failed; rolling back');
    await prisma.workflowHumanStep
      .updateMany({
        data: {
          payload: Prisma.DbNull,
          resolvedAt: null,
          resolvedBy: null,
          status: 'PENDING',
        },
        where: { id: step.id, resolvedBy: user.sub, status: 'RESOLVED' },
      })
      .catch((rollbackErr: unknown) => {
        log.error(
          { err: rollbackErr, stepId: step.id },
          'HITL rollback failed — step stuck RESOLVED without a delivered signal'
        );
      });
    return {
      code: 'SIGNAL_FAILED',
      message: 'Could not deliver the response to the workflow — please retry',
      ok: false,
    };
  }

  return { kind: step.kind, ok: true, stepId: step.id, title: step.title };
}
