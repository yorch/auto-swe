import type { PrismaClient } from '@auto-swe/shared';
import { Prisma } from '@auto-swe/shared';
import { HITL_VALID_ACTIONS, type HitlKind } from '@auto-swe/shared/workflow/interpreter';
import { z } from 'zod';
import { buildWorkflowHumanStepVisibilityFilter } from './runVisibility.js';
import { isTerminalSignalError } from './temporalErrors.js';
import type { ConnectionScopeGate } from './tenantScope.js';

/**
 * Shared HITL resolve core, used by:
 *   - `routes/humanSteps.ts` — POST /api/v1/human-steps/:id/respond (human step API)
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
  /**
   * The GitHub permission gate, supplied by the caller.
   *
   * Answering a step signals the workflow to continue, which is an action on
   * the repository rather than a read of it, so it is gated like the inbox that
   * offered it. It arrives as a dependency rather than being resolved here
   * because the two callers get it differently: the HTTP route inherits
   * `request.repoAccessGate`, while the Slack button authenticates by request
   * signature and has to resolve it. Resolving it inside this core would also
   * make it read config the caller has mocked away.
   *
   * Undefined means the gate is off, which is what an unconfigured deployment
   * and every pre-existing caller mean.
   */
  gate?: ConnectionScopeGate;
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
    where: { id: stepId, ...buildWorkflowHumanStepVisibilityFilter(user, deps.gate) },
  });
  if (!step) {
    return { code: 'NOT_FOUND', message: 'Human step not found', ok: false };
  }
  const resolvedStep = step;
  if (resolvedStep.status !== 'PENDING') {
    return { code: 'ALREADY_RESOLVED', message: 'This step has already been resolved', ok: false };
  }
  if (resolvedStep.run.status !== 'RUNNING') {
    return {
      code: 'RUN_NOT_RUNNING',
      message: 'The workflow run is no longer running',
      ok: false,
    };
  }

  // Validate action against step kind using the shared HITL_VALID_ACTIONS map.
  // The map is Record<HitlKind, …> so TypeScript enforces exhaustiveness whenever
  // a new kind is added to the interpreter — this file stays in sync automatically.
  const allowed = HITL_VALID_ACTIONS[resolvedStep.kind as HitlKind];
  if (!allowed) {
    return { code: 'UNKNOWN_KIND', message: `Unknown step kind: ${resolvedStep.kind}`, ok: false };
  }
  if (!allowed.includes(action)) {
    return {
      code: 'INVALID_ACTION',
      message: `Action '${action}' is not valid for ${resolvedStep.kind} steps. Expected: ${allowed.join(' or ')}`,
      ok: false,
    };
  }

  const validation = validateHitlValue(step, value);
  if (!validation.ok) {
    return { code: 'INVALID_VALUE', message: validation.message, ok: false };
  }
  value = validation.value;

  const signalPayload = { action, resolvedBy: user.sub, value };
  const requiredApprovers = resolvedStep.requiredApprovers;
  const isMultiApprover =
    resolvedStep.kind === 'APPROVAL' && requiredApprovers > 1 && action === 'approve';

  const baseAuditPayload = (
    status: 'PENDING' | 'RESOLVED',
    signalSent: boolean
  ): Prisma.InputJsonValue =>
    ({
      action,
      signalSent,
      status,
      value: value !== undefined ? (value as Prisma.InputJsonValue) : null,
    }) as Prisma.InputJsonValue;

  async function rollbackResolvedStep(auditId: string | undefined): Promise<void> {
    if (isMultiApprover) {
      await prisma.humanApproval.deleteMany({
        where: { resolvedBy: user.sub, stepId: resolvedStep.id },
      });
    }
    if (auditId) {
      await prisma.autonomyDecision.deleteMany({ where: { id: auditId } });
    }
    await prisma.workflowHumanStep.updateMany({
      data: {
        payload: Prisma.DbNull,
        resolvedAt: null,
        resolvedBy: null,
        status: 'PENDING',
      },
      where: { id: resolvedStep.id, resolvedBy: user.sub, status: 'RESOLVED' },
    });
  }

  type ResolveOutcome =
    | { auditId: string; currentApprovers: number; resolved: true }
    | { currentApprovers: number; resolved: false };

  let outcome: ResolveOutcome;

  if (isMultiApprover) {
    // Multi-approver accumulation: record the approval, count distinct
    // approvers, and only resolve the step when the threshold is reached.
    // The row is locked so concurrent approve calls cannot double-count.
    // CLAUDE.md §7 exception: Prisma has no `SELECT … FOR UPDATE`, so the
    // row lock is the one raw query here; everything after it is Prisma.
    outcome = await prisma.$transaction(async (tx) => {
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
        return { currentApprovers: 0, resolved: false };
      }

      let isDuplicate = false;
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
        // advance the step. The unique constraint (stepId, resolvedBy) makes the
        // race safe; we count the existing rows instead.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          isDuplicate = true;
        } else {
          throw err;
        }
      }

      const approvalCount = await tx.humanApproval.count({
        where: { action: 'approve', stepId },
      });
      if (approvalCount < locked.requiredApprovers) {
        // Only write a partial-approval audit event for a new approval. A
        // repeated approval from the same user must stay idempotent and must not
        // produce duplicate autonomy-evidence rows.
        if (!isDuplicate) {
          await tx.autonomyDecision.create({
            data: {
              actorId: user.sub,
              event: 'approve_partial',
              payload: baseAuditPayload('PENDING', false),
              requiredApprovers,
              runId: resolvedStep.run.id,
            },
          });
        }
        return { currentApprovers: approvalCount, resolved: false };
      }

      const update = await tx.workflowHumanStep.updateMany({
        data: {
          payload: signalPayload as Prisma.InputJsonValue,
          resolvedAt: new Date(),
          resolvedBy: user.sub,
          status: 'RESOLVED',
        },
        where: { id: stepId, status: 'PENDING' },
      });
      if (update.count === 0) {
        // Another concurrent response resolved the row between the count and
        // the update. The PENDING status no longer exists — report as not yet
        // resolved so the outer code re-reads and returns ALREADY_RESOLVED.
        return { currentApprovers: approvalCount, resolved: false };
      }

      const audit = await tx.autonomyDecision.create({
        data: {
          actorId: user.sub,
          event: action,
          payload: baseAuditPayload('RESOLVED', false),
          requiredApprovers,
          runId: resolvedStep.run.id,
        },
      });
      return { auditId: audit.id, currentApprovers: approvalCount, resolved: true };
    });
  } else {
    // Single-approver or non-approve action: write the resolution audit atomically
    // with the PENDING→RESOLVED guard so autonomy evidence cannot be lost silently.
    const result = await prisma.$transaction(async (tx) => {
      const update = await tx.workflowHumanStep.updateMany({
        data: {
          payload: signalPayload as Prisma.InputJsonValue,
          resolvedAt: new Date(),
          resolvedBy: user.sub,
          status: 'RESOLVED',
        },
        where: { id: resolvedStep.id, status: 'PENDING' },
      });
      if (update.count === 0) {
        return { auditId: undefined as string | undefined, count: 0 };
      }
      const audit = await tx.autonomyDecision.create({
        data: {
          actorId: user.sub,
          event: action,
          payload: baseAuditPayload('RESOLVED', false),
          requiredApprovers,
          runId: resolvedStep.run.id,
        },
      });
      return { auditId: audit.id, count: update.count };
    });

    if (result.count === 0) {
      return {
        code: 'ALREADY_RESOLVED',
        message: 'This step has already been resolved',
        ok: false,
      };
    }

    outcome = { auditId: result.auditId as string, currentApprovers: 1, resolved: true };
  }

  if (!outcome.resolved) {
    // The step may have been resolved by a concurrent response before this
    // transaction committed. Re-read the authoritative status to avoid telling
    // the caller the step is still pending when it is not.
    const current = await prisma.workflowHumanStep.findUnique({
      select: { status: true },
      where: { id: resolvedStep.id },
    });
    if (current?.status !== 'PENDING') {
      return {
        code: 'ALREADY_RESOLVED',
        message: 'This step has already been resolved',
        ok: false,
      };
    }
    return {
      approvalsRemaining: Math.max(0, requiredApprovers - outcome.currentApprovers),
      currentApprovers: outcome.currentApprovers,
      kind: resolvedStep.kind,
      ok: true,
      requiredApprovers,
      runId: resolvedStep.run.id,
      signalSent: false,
      status: 'PENDING',
      stepId: resolvedStep.id,
      title: resolvedStep.title,
    };
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
    await temporal.signalWorkflow(resolvedStep.run.workflowId, resolvedStep.signalName, [
      signalPayload,
    ]);
  } catch (err: unknown) {
    if (!isTerminalSignalError(err)) {
      log.error({ err, stepId: resolvedStep.id }, 'HITL Temporal signal failed; rolling back');
      try {
        await rollbackResolvedStep(outcome.auditId);
      } catch (rollbackErr: unknown) {
        log.error(
          { err: rollbackErr, stepId: resolvedStep.id },
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
      { err, stepId: resolvedStep.id },
      'HITL signal target workflow no longer exists; keeping the step RESOLVED'
    );
  }

  if (outcome.auditId) {
    await prisma.autonomyDecision
      .updateMany({
        data: { payload: baseAuditPayload('RESOLVED', signalSent) },
        where: { id: outcome.auditId },
      })
      .catch((err) =>
        log.error({ auditId: outcome.auditId, err }, 'Failed to update HITL audit signal status')
      );
  }

  return {
    approvalsRemaining: 0,
    currentApprovers: outcome.currentApprovers,
    kind: resolvedStep.kind,
    ok: true,
    requiredApprovers,
    runId: resolvedStep.run.id,
    signalSent,
    status: 'RESOLVED',
    stepId: resolvedStep.id,
    title: resolvedStep.title,
  };
}
