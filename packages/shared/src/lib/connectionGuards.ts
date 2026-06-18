/**
 * Shared predicate for "is this Connection a usable git repository?" — the
 * single definition behind the gateway submit guards (work requests, epics,
 * scheduled requests, Slack) and the worker's `toRepoRef` narrowing.
 *
 * Since P2/WS3 the git-identity columns are nullable (non-git connection types
 * such as `mcp` leave them unset), so this rule must be checked everywhere a
 * Connection is used as a git repo rather than re-encoded per call site.
 */

/** Minimal structural shape needed to decide git-repo identity. */
export interface GitRepoIdentity {
  type: string;
  organizationName: string | null;
  repoName: string | null;
}

/**
 * True when the connection is `type='git_repo'` and carries both org + repo
 * identity. Type guard so callers narrow `organizationName`/`repoName` to
 * non-null. Non-git types and git rows missing identity are excluded.
 */
export function isGitRepoConnection<T extends GitRepoIdentity>(
  conn: T
): conn is T & { organizationName: string; repoName: string } {
  return conn.type === 'git_repo' && conn.organizationName != null && conn.repoName != null;
}
