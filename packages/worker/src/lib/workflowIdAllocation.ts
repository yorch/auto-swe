import { prisma } from '@auto-swe/shared/db';
import { sameRepositoryIds } from '@auto-swe/shared/lib/sameRepositoryIds';
import {
  chooseWorkflowId,
  generateWorkflowId,
  legacyWorkflowIdBases,
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
 * pick: a row of the same repository (same host, owner and name, whatever
 * the casing) is ours; a foreign row moves the ticket to its disambiguated family, a finished
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
  // A run still in flight under an id the ticket had in an earlier format (stored
  // casing, no host segment) blocks a second one (`chooseWorkflowId`).
  const baseId = generateWorkflowId(
    repo.externalTicketId,
    repo.organizationName,
    repo.repoName,
    repo.githubUrl
  );
  const legacyBaseIds = legacyWorkflowIdBases(
    repo.externalTicketId,
    repo.organizationName,
    repo.repoName,
    repo.githubUrl
  );
  // Rows of the same repository stored under another id still count as ours.
  const owner = {
    externalTicketId: repo.externalTicketId,
    repoId: repo.id,
    sameRepoIds: await sameRepositoryIds(prisma, repo.id),
  };
  const bases = workflowIdFamilyBases(baseId, owner.sameRepoIds, legacyBaseIds);
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
    legacyBaseIds
  );
}
