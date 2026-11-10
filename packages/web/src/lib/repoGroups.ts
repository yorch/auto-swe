import type { BudgetStatus, TeamRef } from '@auto-swe/shared/types/api';
import { launchBudgetHint, launchBudgetReason } from '@/lib/repoLaunch';

/** The team a piece of work is being started for. */
export interface ScopeTeam {
  id: string;
  name: string;
}

export interface RepoGroup<T> {
  key: string;
  label: string;
  repos: T[];
}

interface Groupable {
  /** Always present from the gateway; tolerated as absent so a row without one is not dropped. */
  team?: TeamRef;
  shares?: Array<{ canLaunch?: boolean; team: TeamRef }>;
  launchBudget?: BudgetStatus | null;
}

/**
 * Reachable repositories grouped by the team that owns them. With a scope team the groups are
 * that team's own repositories ("Payments"), then those shared with it ("Shared with
 * Payments"), then every other owning team by name; without one, every owning team by name.
 * Work on a repository runs under its owning team, so the grouping is also the answer to "which
 * team is this under".
 */
export function groupReposByTeam<T extends Groupable>(
  repos: T[],
  scope: ScopeTeam | null
): RepoGroup<T>[] {
  const byName = (a: T, b: T) => (a.team?.name ?? '').localeCompare(b.team?.name ?? '');
  const groups: RepoGroup<T>[] = [];
  const rest: T[] = [];
  if (scope) {
    const owned = repos.filter((r) => r.team?.id === scope.id);
    const shared = repos.filter(
      (r) => r.team?.id !== scope.id && (r.shares ?? []).some((s) => s.team.id === scope.id)
    );
    if (owned.length) {
      groups.push({ key: `team:${scope.id}`, label: scope.name, repos: owned });
    }
    if (shared.length) {
      groups.push({ key: `shared:${scope.id}`, label: `Shared with ${scope.name}`, repos: shared });
    }
    const seen = new Set([...owned, ...shared]);
    rest.push(...repos.filter((r) => !seen.has(r)));
  } else {
    rest.push(...repos);
  }
  const byTeam = new Map<string, RepoGroup<T>>();
  for (const repo of [...rest].sort(byName)) {
    const id = repo.team?.id ?? '';
    const group = byTeam.get(id) ?? { key: `team:${id}`, label: repo.team?.name ?? '', repos: [] };
    group.repos.push(repo);
    byTeam.set(id, group);
  }
  return [...groups, ...byTeam.values()];
}

/**
 * Combobox options for `repos`, in group order, each carrying its group as the second line and as
 * part of what typing matches. A repository with no team shows no second line.
 */
export function groupedRepoOptions<T extends Groupable & { id: string }>(
  repos: T[],
  scope: ScopeTeam | null,
  label: (repo: T) => string,
  /** A reason a repository cannot be picked; it is listed disabled with the reason beside it. */
  blockedReason?: (repo: T) => string | null
) {
  return groupReposByTeam(repos, scope).flatMap((group) =>
    group.repos.map((repo) => {
      // An exhausted launch budget blocks like view only does; a nearing one only shows its percent.
      const reason = blockedReason?.(repo) ?? launchBudgetReason(repo);
      const hint = reason ? null : launchBudgetHint(repo);
      const description = [group.label, reason ?? hint?.text].filter(Boolean).join(' · ');
      return {
        description: description || undefined,
        ...(reason ? { disabled: true } : {}),
        ...(hint?.warn ? { tone: 'warning' as const } : {}),
        label: label(repo),
        textValue: `${label(repo)} ${group.label}`.trim(),
        value: repo.id,
      };
    })
  );
}
