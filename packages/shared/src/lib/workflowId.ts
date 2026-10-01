/**
 * Generate a deterministic Temporal workflow ID.
 *
 * The ID must be unique across all workflows to avoid collisions.
 * Including organizationName prevents collisions between repos with
 * the same name in different organizations.
 *
 * A repository on a host other than the instance's own — its `githubUrl`
 * override — also carries that host, because `acme/api` on github.com and on a
 * GitHub Enterprise server are different repositories and must not share
 * workflow ids. A repository on the instance host has no override and keeps
 * exactly the id it always had, so nothing already running changes.
 */
export function generateWorkflowId(
  externalTicketId: string,
  organizationName: string,
  repoName: string,
  githubUrl?: string | null
): string {
  const host = githubUrl ? hostSegment(githubUrl) : null;
  return host
    ? `eng-${host}-${organizationName}-${repoName}-${externalTicketId}`
    : `eng-${organizationName}-${repoName}-${externalTicketId}`;
}

function hostSegment(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Generate a branch name for a work request.
 */
export function generateBranchName(externalTicketId: string, branchPrefix?: string): string {
  const prefix = branchPrefix ?? process.env.BRANCH_PREFIX ?? 'auto';
  return `${prefix}/${externalTicketId}`;
}
