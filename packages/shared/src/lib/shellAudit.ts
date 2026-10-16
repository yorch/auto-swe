/**
 * `WorkflowShellAudit` rows: the record of who let each piece of authored code in a template
 * version run — one row per container node and per authored command (see `containerCode.ts`).
 * The gateway writes them when a version is saved, reviewed, promoted or activated and when a
 * bundle installs one; `syncBuiltins` writes them for the built-in versions it ships.
 */

import type { ShellNodeWithId } from '../workflow/containerCode.js';
import { runUnscoped } from './tenantGuard.js';

interface ShellAuditRowInput {
  authorUserId: string | null;
  command: string;
  egressAllowlistSnapshot: string[];
  image: string;
  network: string;
  nodeId: string;
  teamId: string | null;
  templateVersionId: string;
}

/** The slice of a Prisma client (or transaction client) these helpers use. */
export interface ShellAuditClient {
  workflowShellAudit: {
    createMany(args: { data: ShellAuditRowInput[] }): Promise<unknown>;
    findMany(args: {
      select: { command: true; image: true; nodeId: true };
      where: { templateVersionId: string };
    }): Promise<Array<{ command: string; image: string; nodeId: string }>>;
  };
}

/**
 * Insert the audit rows. Accepts either the singleton prisma client or a
 * transaction client so the caller can wrap the version write + audit in a
 * single atomic step — without that, a failed audit insert leaves the version
 * row in place and the API reports an error, an inconsistency that's hard
 * to reconcile later. A null author is the platform itself (`syncBuiltins`).
 */
export async function recordShellAudit(
  tx: Pick<ShellAuditClient, 'workflowShellAudit'>,
  templateVersionId: string,
  teamId: string | null,
  authorUserId: string | null,
  auditNodes: ShellNodeWithId[],
  egressAllowlist: string[]
): Promise<void> {
  if (auditNodes.length === 0) {
    return;
  }
  await tx.workflowShellAudit.createMany({
    data: auditNodes.map(({ id, node }) => ({
      authorUserId,
      command: node.command,
      egressAllowlistSnapshot: egressAllowlist,
      image: node.image,
      network: node.network ?? 'none',
      nodeId: id,
      teamId,
      templateVersionId,
    })),
  });
}

/** What one row vouches for: this command, in this image, on this node. */
function auditKey(nodeId: string, image: string, command: string): string {
  return JSON.stringify([nodeId, image, command]);
}

/**
 * The nodes of `authoredNodes` no row of the version covers. A row covers exactly the node,
 * image and command it records, so one audited gate of a `runQualityGates` node vouches for no
 * other.
 */
export async function findUnauditedNodes(
  client: ShellAuditClient,
  templateVersionId: string,
  authoredNodes: ShellNodeWithId[]
): Promise<ShellNodeWithId[]> {
  if (authoredNodes.length === 0) {
    return [];
  }
  // Scoped by the version, which the caller has already decided it may act on. A row's own
  // `teamId` cannot scope it: it is null on a global template and on a deleted team.
  const rows = await runUnscoped(
    'audit rows of one template version the caller may act on',
    ['WorkflowShellAudit'],
    () =>
      client.workflowShellAudit.findMany({
        select: { command: true, image: true, nodeId: true },
        where: { templateVersionId },
      })
  );
  const audited = new Set(rows.map((r) => auditKey(r.nodeId, r.image, r.command)));
  return authoredNodes.filter(
    ({ id, node }) => !audited.has(auditKey(id, node.image, node.command))
  );
}
