import type { PrismaClient } from '@auto-swe/shared';
import { Prisma } from '@auto-swe/shared';
import { HITL_VALID_ACTIONS, type HitlKind } from '@auto-swe/shared/workflow/interpreter';
import { z } from 'zod';
import { buildWorkflowHumanStepVisibilityFilter } from './runVisibility.js';
import { isTerminalSignalError } from './temporalErrors.js';

/**
 * Shared HITL resolve core, used by:
 *   - `routes/humanSteps.ts` — POST /inbox/:id/respond (the inbox UI)
 *   - `routes/slack.ts`      — `hitl_resolve` Block Kit button interactions
 *
 * Both entry points enforce the SAME authorization (team visibility via
 * {@link buildWorkflowHumanStepVisibilityFilter}), the same action validation, the same atomic
 * PENDING→RESOLVED guard, and the same Temporal-signal-with-rollback semantics.
 * The HTTP wire contracts live in the callers; this module only returns a
 * typed result.
 *
 * For `APPROVAL` kind with `requiredApprovers > 1`, this module is also an
 * approval accumulator: each `approve` response creates a `HumanApproval` row
 * and the step is only resolved (and the workflow signalled) once the count
 * of distinct approvers reaches the threshold.
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
  log: { error(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
}

export type HitlResolveErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_RESOLVED'
  | 'RUN_NOT_RUNNING'
  | 'UNKNOWN_KIND'
  | 'INVALID_ACTION'
  | 'INVALID_VALUE'
  | 'SIGNAL_FAILED';

export type HitlResolveResult =
  | {
      ok: true;
      stepId: string;
      runId: string;
      kind: string;
      title: string;
      /**
       * 'RESOLVED' when this response crossed the approval threshold (or was a
       * non-approve / non-APPROVAL action). 'PENDING' when the response was
       * recorded but more approvals are still needed.
       */
      status: 'PENDING' | 'RESOLVED';
      /**
       * False when the step was resolved but the target workflow no longer
       * exists, so the signal could not be — and never will be — delivered.
       * The resolution stands (see {@link resolveHitlStep}); callers surface it
       * as success-with-caveat. Same field and same meaning as the merge
       * webhook's `signalSent`.
       */
      signalSent: boolean;
      /** Total number of distinct approvers required for this step. */
      requiredApprovers: number;
      /** Number of distinct approvals already recorded. */
      currentApprovers: number;
      /** How many more distinct approvals are still needed. */
      approvalsRemaining: number;
    }
  | { ok: false; code: HitlResolveErrorCode; message: string };

const DecisionOptionValueSchema = z.array(z.object({ value: z.string().min(1).max(100) }));

const InputFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  type: z.enum(['text', 'number', 'boolean', 'select']),
});

const InputFieldsSchema = z.array(InputFieldSchema).min(1).max(20);

interface HitlStepShape {
  fields: Prisma.JsonValue;
  kind: string;
  options: Prisma.JsonValue;
}

interface ValueValidationSuccess {
  ok: true;
  value: unknown;
}

interface ValueValidationFailure {
  message: string;
  ok: false;
}

type ValueValidationResult = ValueValidationSuccess | ValueValidationFailure;

function isEmptyInputValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v === '');
}

/**
 * Validate the submitted `value` against the step's kind and stored
 * configuration. This is the single chokepoint for both the inbox and Slack
 * resolve paths, so malformed payloads cannot be persisted or signalled.
 */
function validateHitlValue(step: HitlStepShape, value: unknown): ValueValidationResult {
  const kind = step.kind as HitlKind;

  switch (kind) {
    case 'APPROVAL': {
      if (value !== undefined && value !== null) {
        return { message: 'APPROVAL steps only accept an action; do not send a value.', ok: false };
      }
      return { ok: true, value: undefined };
    }

    case 'REVIEW': {
      if (isEmptyInputValue(value)) {
        return { ok: true, value: undefined };
      }
      if (typeof value !== 'string') {
        return { message: 'REVIEW value must be a string.', ok: false };
      }
      if (value.length > 2000) {
        return { message: 'REVIEW value must be at most 2000 characters.', ok: false };
      }
      return { ok: true, value };
    }

    case 'DECISION': {
      if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
        return { message: 'DECISION value must be a non-empty option string.', ok: false };
      }
      const parsed = DecisionOptionValueSchema.safeParse(step.options);
      if (!parsed.success || parsed.data.length === 0) {
        return { message: 'DECISION step options are missing or invalid.', ok: false };
      }
      const optionValues = parsed.data.map((o) => o.value);
      if (!optionValues.includes(value)) {
        return {
          message: `DECISION value '${value}' is not one of the configured options.`,
          ok: false,
        };
      }
      return { ok: true, value };
    }

    case 'INPUT': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return {
          message: 'INPUT value must be an object keyed by the configured field keys.',
          ok: false,
        };
      }
      const parsedFields = InputFieldsSchema.safeParse(step.fields);
      if (!parsedFields.success) {
        return { message: 'Step field configuration is invalid.', ok: false };
      }
      const record = value as Record<string, unknown>;
      const fieldKeys = new Set(parsedFields.data.map((field) => field.key));
      const errors: string[] = [];

      for (const key of Object.keys(record)) {
        if (!fieldKeys.has(key)) {
          errors.push(`Unknown field '${key}'.`);
        }
      }

      for (const field of parsedFields.data) {
        const v = record[field.key];
        const missing = isEmptyInputValue(v);
        if (field.required && missing) {
          errors.push(`Field '${field.label}' is required.`);
          continue;
        }
        if (missing) {
          continue;
        }
        if (field.type === 'text') {
          if (typeof v !== 'string' || v.length > 10000) {
            errors.push(`Field '${field.label}' must be a string of at most 10000 characters.`);
          }
        } else if (field.type === 'number') {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`Field '${field.label}' must be a finite number.`);
          }
        } else if (field.type === 'boolean') {
          if (typeof v !== 'boolean') {
            errors.push(`Field '${field.label}' must be a boolean.`);
          }
        } else if (field.type === 'select') {
          if (typeof v !== 'string') {
            errors.push(`Field '${field.label}' must be a string.`);
          } else if (field.options && !field.options.includes(v)) {
            errors.push(`Field '${field.label}' must be one of the configured options.`);
          }
        }
      }
      if (errors.length > 0) {
        return { message: errors.join(' '), ok: false };
      }
      return { ok: true, value };
    }

    default:
      return { message: `Unknown step kind: ${kind}`, ok: false };
  }
}

/**
 * Resolve a pending human step on behalf of `user`.
 *
 * Sequence (must stay in lock-step with what the inbox route promised):
 *   1. Visibility-scoped lookup (404-equivalent when not found / not visible)
 *   2. Optimistic PENDING + run-RUNNING checks
 *   3. Action validation against HITL_VALID_ACTIONS for the step kind
 *   4. For multi-approver APPROVAL steps, accumulate approval in a transaction.
 *   5. Atomic PENDING→RESOLVED updateMany (the real concurrency guard)
 *   6. Temporal signal; on a TRANSIENT failure roll the row back to PENDING so
 *      the user can retry instead of stranding the run. On a TERMINAL one the
 *      resolution stands — see the signal block for why.
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
    include: { run: { select: { id: true, status: true, workflowId: true } } },
    where: { id: stepId, ...buildWorkflowHumanStepVisibilityFilter(user) },
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

  const validation = validateHitlValue(step, value);
  if (!validation.ok) {
    return { code: 'INVALID_VALUE', message: validation.message, ok: false };
  }
  value = validation.value;

  const signalPayload = { action, resolvedBy: user.sub, value };
  const requiredApprovers = step.requiredApprovers;
  const isMultiApprover = step.kind === 'APPROVAL' && requiredApprovers > 1 && action === 'approve';
  let multiApproverState: { resolved: boolean; approvalCount: number } | null = null;

  if (isMultiApprover) {
    // Multi-approver accumulation: record the approval, count distinct
    // approvers, and only resolve the step when the threshold is reached.
    // The row is locked so concurrent approve calls cannot double-count.
    // CLAUDE.md §7 exception: Prisma has no `SELECT … FOR UPDATE`, so the
    // row lock is the one raw query here; everything after it is Prisma.
    try {
      multiApproverState = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; status: string; requiredApprovers: number }>
        >(
          Prisma.sql`
            SELECT id, status, required_approvers AS "requiredApprovers"
            FROM workflow_human_steps
            WHERE id = ${stepId}::uuid
            FOR UPDATE
          `
        );
        if (locked?.status !== 'PENDING') {
          return { approvalCount: 0, resolved: false };
        }

        try {
          await tx.humanApproval.create({
            data: {
              action,
              resolvedBy: user.sub,
              stepId,
              value: value !== undefined ? (value as Prisma.InputJsonValue) : undefined,
            },
          });
        } catch (err: unknown) {
          // One response per approver; a duplicate from the same user does not
          // advance the step. Count the existing rows instead.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
            throw err;
          }
        }

        const approvalCount = await tx.humanApproval.count({
          where: { action: 'approve', stepId },
        });
        if (approvalCount < locked.requiredApprovers) {
          return { approvalCount, resolved: false };
        }

        try {
          await tx.workflowHumanStep.update({
            data: {
              payload: signalPayload as Prisma.InputJsonValue,
              resolvedAt: new Date(),
              resolvedBy: user.sub,
              status: 'RESOLVED',
            },
            where: { id: stepId, status: 'PENDING' },
          });
        } catch (err: unknown) {
          // Another concurrent response resolved the row between the count and
          // the update. The PENDING status no longer exists — report as not yet
          // resolved so the outer code re-reads and returns ALREADY_RESOLVED.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            return { approvalCount, resolved: false };
          }
          throw err;
        }
        return { approvalCount, resolved: true };
      });
    } catch (err: unknown) {
      log.error({ err, stepId: step.id }, 'Multi-approver HITL transaction failed');
      return {
        code: 'SIGNAL_FAILED',
        message: 'Could not record the approval — please retry',
        ok: false,
      };
    }

    if (!multiApproverState.resolved) {
      const approvalCount = multiApproverState.approvalCount;
      // The step may have been resolved by a concurrent response before this
      // transaction committed. Re-read the authoritative status to avoid telling
      // the caller the step is still pending when it is not.
      const current = await prisma.workflowHumanStep.findUnique({
        select: { status: true },
        where: { id: step.id },
      });
      if (current?.status !== 'PENDING') {
        return {
          code: 'ALREADY_RESOLVED',
          message: 'This step has already been resolved',
          ok: false,
        };
      }
      const currentApprovers = approvalCount;
      await prisma.autonomyDecision
        .create({
          data: {
            actorId: user.sub,
            event: 'approve_partial',
            payload: {
              action,
              signalSent: false,
              status: 'PENDING',
              value: value !== undefined ? (value as Prisma.InputJsonValue) : null,
            } as Prisma.InputJsonValue,
            requiredApprovers,
            runId: step.run.id,
          },
        })
        .catch((err) =>
          log.error({ err, stepId: step.id }, 'Failed to write partial approval audit record')
        );
      return {
        approvalsRemaining: Math.max(0, requiredApprovers - currentApprovers),
        currentApprovers,
        kind: step.kind,
        ok: true,
        requiredApprovers,
        runId: step.run.id,
        signalSent: false,
        status: 'PENDING',
        stepId: step.id,
        title: step.title,
      };
    }
  } else {
    // Single-approver or non-approve action: the existing atomic guard is enough.
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
      return {
        code: 'ALREADY_RESOLVED',
        message: 'This step has already been resolved',
        ok: false,
      };
    }
  }

  // Deliver the Temporal signal. The workflow only unblocks via this signal, so
  // a TRANSIENT failure after the row was marked RESOLVED would strand it: the
  // step would vanish from the inbox while the workflow stays stuck until its
  // timeout. Roll the row back to PENDING so the human can retry.
  //
  // A TERMINAL failure is the opposite case: the execution is gone (never
  // started, already completed, or terminated), so no retry can ever land the
  // signal and there is no run left to strand. Rolling back would return the
  // step to the inbox permanently unclearable — every retry re-fails the same
  // way — and would discard a decision the human legitimately made. Keep the
  // resolution and report success with `signalSent: false`, matching what the
  // merge webhook does with a terminal signal failure.
  let signalSent = true;
  try {
    await temporal.signalWorkflow(step.run.workflowId, step.signalName, [signalPayload]);
  } catch (err: unknown) {
    if (!isTerminalSignalError(err)) {
      log.error({ err, stepId: step.id }, 'HITL Temporal signal failed; rolling back');
      try {
        if (isMultiApprover) {
          await prisma.humanApproval.deleteMany({
            where: { resolvedBy: user.sub, stepId: step.id },
          });
        }
        await prisma.workflowHumanStep.updateMany({
          data: {
            payload: Prisma.DbNull,
            resolvedAt: null,
            resolvedBy: null,
            status: 'PENDING',
          },
          where: { id: step.id, resolvedBy: user.sub, status: 'RESOLVED' },
        });
      } catch (rollbackErr: unknown) {
        log.error(
          { err: rollbackErr, stepId: step.id },
          'HITL rollback failed — step stuck RESOLVED without a delivered signal'
        );
      }
      return {
        code: 'SIGNAL_FAILED',
        message: 'Could not deliver the response to the workflow — please retry',
        ok: false,
      };
    }
    signalSent = false;
    log.warn(
      { err, stepId: step.id },
      'HITL signal target workflow no longer exists; keeping the step RESOLVED'
    );
  }

  const currentApprovers =
    isMultiApprover && multiApproverState ? multiApproverState.approvalCount : 1;
  await prisma.autonomyDecision
    .create({
      data: {
        actorId: user.sub,
        event: action,
        payload: {
          action,
          signalSent,
          status: 'RESOLVED',
          value: value !== undefined ? (value as Prisma.InputJsonValue) : null,
        } as Prisma.InputJsonValue,
        requiredApprovers,
        runId: step.run.id,
      },
    })
    .catch((err) =>
      log.error({ err, stepId: step.id }, 'Failed to write HITL resolution audit record')
    );
  return {
    approvalsRemaining: 0,
    currentApprovers,
    kind: step.kind,
    ok: true,
    requiredApprovers,
    runId: step.run.id,
    signalSent,
    status: 'RESOLVED',
    stepId: step.id,
    title: step.title,
  };
}
