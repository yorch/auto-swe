import { prisma } from '@auto-swe/shared/db';
import {
  chooseWorkflowId,
  generateWorkflowId,
  type WorkflowIdAllocation,
  workflowIdFamilyBases,
} from '@auto-swe/shared/lib/workflowId';

/**
 * Allocate the Temporal workflow ID for a ticket in one repository, from the
 * worker side — the counterpart of the gateway's `allocateWorkflowId`, over the
 * same shared rules (`chooseWorkflowId`).
 *
 * The base `eng-<org>-<repo>-<ticket>` is not unique across repositories (every
 * part may contain hyphens), so a workflow ID built by hand can land on another
 * tenant's running workflow and be silently swallowed as "already started".
 * This reads the rows in the ticket's ID family and lets `chooseWorkflowId`
 * pick: a foreign row moves the ticket to its disambiguated family, a finished
 * run of the same ticket gets an `-rN` rerun ID, and a run of the same ticket
 * still in flight is returned as a conflict.
 */
export async function allocateTicketWorkflowId(repo: {
  id: string;
  organizationName: string;
  repoName: string;
  externalTicketId: string;
  /** The repository's web base override; null/absent on the instance's own host. */
  githubUrl?: string | null;
}): Promise<WorkflowIdAllocation> {
  // A repository on another host carries it in the id; a run still in flight under
  // the id the ticket had before that blocks a second one (`chooseWorkflowId`).
  const baseId = generateWorkflowId(
    repo.externalTicketId,
    repo.organizationName,
    repo.repoName,
    repo.githubUrl
  );
  const legacyBaseId = repo.githubUrl
    ? generateWorkflowId(repo.externalTicketId, repo.organizationName, repo.repoName)
    : undefined;
  const owner = { externalTicketId: repo.externalTicketId, repoId: repo.id };
  const bases = workflowIdFamilyBases(baseId, owner.repoId, legacyBaseId);
  const rows = await prisma.activeWorkflow.findMany({
    select: {
      currentStatus: true,
      repoId: true,
      temporalWorkflowId: true,
      workRequest: { select: { externalTicketId: true } },
    },
    where: {
      OR: bases.flatMap((b) => [
        { temporalWorkflowId: b },
        { temporalWorkflowId: { startsWith: `${b}-r` } },
      ]),
    },
  });
  return chooseWorkflowId(
    baseId,
    rows.map((r) => ({
      currentStatus: r.currentStatus,
      externalTicketId: r.workRequest?.externalTicketId ?? null,
      repoId: r.repoId,
      temporalWorkflowId: r.temporalWorkflowId,
    })),
    owner,
    legacyBaseId
  );
}
