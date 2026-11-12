/**
 * An endpoint's `cancelOnTypes` (docs/inbound-events.md): an event of one of those types cancels
 * the runs this endpoint's automations started for the same subject and are still running, as
 * the dashboard's cancel does. A PagerDuty `incident.resolved` stops the incident's triage.
 */
import { endpointOwnerKey, type InboundEvent } from '@auto-swe/shared/automation';
import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../auditLog.js';
import { recordRunFinalized } from '../metrics.js';
import { isTerminalSignalError } from '../temporalErrors.js';

/** A cancel Temporal did not accept: the run stays RUNNING, and a redelivery tries again. */
export class RunCancelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunCancelError';
  }
}

/** How many runs this event cancelled. */
export async function cancelRunsOnEvent(
  fastify: FastifyInstance,
  endpoint: { id: string; cancelOnTypes: string[] },
  event: InboundEvent
): Promise<number> {
  if (!endpoint.cancelOnTypes.includes(event.type)) {
    return 0;
  }
  const fires = await fastify.prisma.automationFire.findMany({
    select: { temporalWorkflowId: true },
    where: {
      outcome: 'STARTED',
      ownerKey: endpointOwnerKey(endpoint.id),
      subjectKey: event.subject,
      temporalWorkflowId: { not: null },
    },
  });
  const workflowIds = fires.flatMap((f) => (f.temporalWorkflowId ? [f.temporalWorkflowId] : []));
  if (workflowIds.length === 0) {
    return 0;
  }
  const runs = await fastify.prisma.workflowRun.findMany({
    select: { id: true, workflowId: true },
    where: { status: 'RUNNING', workflowId: { in: workflowIds } },
  });
  let cancelled = 0;
  let failure: unknown = null;
  for (const run of runs) {
    if (run.workflowId) {
      try {
        await fastify.temporal.cancelWorkflow(run.workflowId);
      } catch (err) {
        // An execution Temporal no longer knows has nothing left to cancel.
        if (!isTerminalSignalError(err)) {
          fastify.log.error({ err, workflowId: run.workflowId }, 'Temporal cancel failed');
          failure = err;
          continue;
        }
      }
    }
    // The workflow's own cancellation path finalizes the run with billing (`endedAt`), as it
    // does after the dashboard's cancel; the status predicate never overwrites a terminal state.
    const { count } = await fastify.prisma.workflowRun.updateMany({
      data: { status: 'CANCELLED' },
      where: { id: run.id, status: 'RUNNING' },
    });
    if (count === 0) {
      continue;
    }
    recordRunFinalized('CANCELLED', 'gateway');
    cancelled++;
    if (run.workflowId) {
      await fastify.prisma.activeWorkflow.updateMany({
        data: { currentStatus: 'CANCELLED' },
        where: { temporalWorkflowId: run.workflowId },
      });
    }
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor: null,
      after: {
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: event.type,
        status: 'CANCELLED',
      },
      before: { status: 'RUNNING' },
      entityId: run.id,
      entityType: 'WorkflowRun',
    });
  }
  if (failure !== null) {
    throw new RunCancelError('A run could not be cancelled in Temporal', { cause: failure });
  }
  return cancelled;
}
