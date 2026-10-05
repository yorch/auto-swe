/**
 * The states a tracked pull request moves through, and the two pieces of host
 * data every surface derives the same way: the title (untrusted text, capped)
 * and the link to the PR on its host.
 */

/** `PullRequest.status`. CLOSED is closed without merging. */
export const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** Longest title stored; a host allows more, and the list needs none of it. */
export const PULL_REQUEST_TITLE_MAX_LENGTH = 300;

/** A host-supplied title as stored: trimmed and capped, null when nothing is left. */
export function clampPullRequestTitle(title: string | null | undefined): string | null {
  // By code point, so a surrogate pair is never cut in half.
  const trimmed = Array.from(title?.trim() ?? '')
    .slice(0, PULL_REQUEST_TITLE_MAX_LENGTH)
    .join('');
  return trimmed ? trimmed : null;
}

/** The repository fields a PR link is built from. */
export interface PullRequestRepo {
  organizationName: string | null;
  repoName: string | null;
  /** The repository's own web base; null means github.com. */
  githubUrl?: string | null;
}

/**
 * The PR's address on its host. The one derivation: a repository may live on
 * a GHE host, so the instance's base is not assumed. Null when a part is
 * missing or the base is not an http(s) URL, so a malformed legacy value is
 * never linked.
 */
export function pullRequestUrl(repo: PullRequestRepo, prNumber: number | null): string | null {
  if (prNumber == null || !repo.organizationName || !repo.repoName) {
    return null;
  }
  try {
    const base = new URL(repo.githubUrl ?? 'https://github.com');
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      return null;
    }
    return `${base.href.replace(/\/$/, '')}/${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}/pull/${prNumber}`;
  } catch {
    return null;
  }
}
