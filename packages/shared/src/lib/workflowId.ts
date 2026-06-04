/**
 * Generate a deterministic Temporal workflow ID.
 *
 * The ID must be unique across all workflows to avoid collisions.
 * Including organizationName prevents collisions between repos with
 * the same name in different organizations.
 */
export function generateWorkflowId(
  externalTicketId: string,
  organizationName: string,
  repoName: string
): string {
  return `eng-${organizationName}-${repoName}-${externalTicketId}`;
}

/**
 * Generate a branch name for a work request.
 */
export function generateBranchName(externalTicketId: string, branchPrefix?: string): string {
  const prefix = branchPrefix ?? process.env.BRANCH_PREFIX ?? 'auto';
  return `${prefix}/${externalTicketId}`;
}
