import type { PrismaClient } from '@auto-swe/shared';
import type { AccessLog } from '@auto-swe/shared/lib/accessActor';
import type { RunTrigger } from '@auto-swe/shared/lib/runTrigger';
import type { RunRequest } from '@auto-swe/shared/types/workflow';

type ProvenanceFields = Pick<
  RunRequest,
  'initiatedById' | 'initiatedByServiceId' | 'rerunOfRunId' | 'trigger' | 'triggerRefId'
>;

/**
 * The provenance a launch door stamps on the `RunRequest` it starts, which the worker writes once
 * onto `WorkflowRun`. It is recorded and never read back for a decision: `launchedById` stays the
 * credential key and is set separately by each door. Each door passes only what it knows — a user
 * (`actor`), a service principal (`serviceId`), neither for a webhook — and keys with no value are
 * left off the request.
 *
 * The door is stamped here rather than inside `launchTrackedWorkflow` because that function
 * receives the start as a closure and never sees the request that becomes the workflow input.
 */
export function runProvenance(input: {
  trigger: RunTrigger;
  actor?: { sub: string } | null;
  serviceId?: string | null;
  triggerRefId?: string | null;
  rerunOfRunId?: string | null;
}): ProvenanceFields {
  return {
    trigger: input.trigger,
    ...(input.actor ? { initiatedById: input.actor.sub } : {}),
    ...(input.serviceId ? { initiatedByServiceId: input.serviceId } : {}),
    ...(input.triggerRefId ? { triggerRefId: input.triggerRefId } : {}),
    ...(input.rerunOfRunId ? { rerunOfRunId: input.rerunOfRunId } : {}),
  };
}

/**
 * The `WorkflowRun.id` (not a workflow id) of the newest earlier run of a work request, for a
 * re-run to name as `rerunOfRunId`. Undefined when the request has no run row yet, or when the
 * lookup fails: provenance is recorded only, so it never fails the re-run it describes.
 */
export async function latestRunIdForWorkRequest(
  prisma: Pick<PrismaClient, 'workflowRun'>,
  workRequestId: string,
  log?: AccessLog
): Promise<string | undefined> {
  try {
    const previous = await prisma.workflowRun.findFirst({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      where: { workRequestId },
    });
    return previous?.id;
  } catch (err) {
    log?.warn({ err, workRequestId }, 'the run a re-run repeats could not be looked up');
    return undefined;
  }
}
