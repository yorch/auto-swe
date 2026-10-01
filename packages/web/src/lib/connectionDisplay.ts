import type { RepositorySummary } from '@auto-swe/shared/types/api';

export function connectionLabel(r: RepositorySummary): string {
  if (!r.type || r.type === 'git_repo') {
    return `${r.organizationName ?? ''}/${r.repoName ?? ''}`;
  }
  return r.name ?? r.type;
}

/**
 * Label for a repo reference that carries only its name fields — either end of
 * a dependency edge. `org/repo` when both are known, else the connection name,
 * else the id.
 */
export function repoRefLabel(repo: {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  name: string | null;
}): string {
  if (repo.organizationName && repo.repoName) {
    return `${repo.organizationName}/${repo.repoName}`;
  }
  return repo.name ?? repo.id;
}
