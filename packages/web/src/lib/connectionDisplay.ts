import type { RepositorySummary } from '@auto-swe/shared/types/api';

export function connectionLabel(r: RepositorySummary): string {
  if (!r.type || r.type === 'git_repo') {
    return `${r.organizationName ?? ''}/${r.repoName ?? ''}`;
  }
  return r.name ?? r.type;
}
