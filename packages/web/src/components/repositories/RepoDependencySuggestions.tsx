'use client';

import { useMemo } from 'react';
import { LoadingState } from '@/components/ui/LoadingState';
import { errMsg } from '@/lib/errors';

/** The repo side of an unresolved-edge row — enough to label and link it. */
export interface SuggestionSourceRepo {
  id: string;
  organizationName: string | null;
  repoName: string | null;
  name: string | null;
}

/**
 * One unresolved `RepoDependency` row (`status: 'unresolved'`, `toRepoId:
 * null`) as the onboarding view needs it: the raw dependency string plus the
 * repo that referenced it. The caller (org-wide listing, or a single repo's
 * filtered `dependsOn`) supplies these already scoped to what the viewer may
 * see — this component only groups and renders.
 */
export interface UnresolvedDependencySuggestion {
  id: string;
  toRef: string;
  kind: string;
  source: string;
  confidence: number;
  fromRepo: SuggestionSourceRepo;
}

interface SuggestionGroup {
  toRef: string;
  edgeIds: string[];
  repos: SuggestionSourceRepo[];
  kinds: string[];
  sources: string[];
}

function repoLabel(repo: SuggestionSourceRepo): string {
  if (repo.organizationName && repo.repoName) {
    return `${repo.organizationName}/${repo.repoName}`;
  }
  return repo.name ?? repo.id;
}

/** Group unresolved edges by `toRef`, collapsing repeats of the same referencing repo. */
function groupByToRef(suggestions: UnresolvedDependencySuggestion[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const s of suggestions) {
    const existing = groups.get(s.toRef);
    if (existing) {
      if (!existing.repos.some((r) => r.id === s.fromRepo.id)) {
        existing.repos.push(s.fromRepo);
      }
      if (!existing.kinds.includes(s.kind)) {
        existing.kinds.push(s.kind);
      }
      if (!existing.sources.includes(s.source)) {
        existing.sources.push(s.source);
      }
      existing.edgeIds.push(s.id);
    } else {
      groups.set(s.toRef, {
        edgeIds: [s.id],
        kinds: [s.kind],
        repos: [s.fromRepo],
        sources: [s.source],
        toRef: s.toRef,
      });
    }
  }
  // Most-referenced first — that's the onboarding priority signal.
  return [...groups.values()].sort((a, b) => b.repos.length - a.repos.length);
}

function SuggestionRow({ group }: { group: SuggestionGroup }) {
  return (
    <li className="border-ink-600 border-b py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium font-mono text-sm">{group.toRef}</span>
        <span className="shrink-0 font-mono text-[10px] text-paper-500 uppercase tracking-wider">
          {group.repos.length} {group.repos.length === 1 ? 'repo' : 'repos'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-paper-400 text-xs">
        <span>{group.repos.map(repoLabel).join(', ')}</span>
        <span className="text-paper-500">
          {group.kinds.join(', ')} · {group.sources.join(', ')}
        </span>
      </div>
    </li>
  );
}

export function RepoDependencySuggestions({
  suggestions,
  isLoading = false,
  isError = false,
  error,
  emptyText = 'No onboarding suggestions — every detected dependency resolves to an onboarded repository.',
}: {
  suggestions: UnresolvedDependencySuggestion[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  emptyText?: string;
}) {
  const groups = useMemo(() => groupByToRef(suggestions ?? []), [suggestions]);

  if (isLoading) {
    return <LoadingState message="Loading onboarding suggestions…" />;
  }

  if (isError) {
    return (
      <p className="py-6 text-center text-brick-400 text-sm">
        {errMsg(error, 'Could not load onboarding suggestions.')}
      </p>
    );
  }

  if (groups.length === 0) {
    return <p className="text-paper-400 text-sm">{emptyText}</p>;
  }

  return (
    <section>
      <h4 className="mb-1 font-semibold text-sm">Onboarding suggestions</h4>
      <p className="mb-2 text-paper-500 text-xs">
        Dependencies detected in manifests or git signals that don't resolve to an onboarded
        repository yet, grouped by the unresolved reference and ranked by how many repos declare it.
      </p>
      <ul>
        {groups.map((group) => (
          <SuggestionRow group={group} key={group.toRef} />
        ))}
      </ul>
    </section>
  );
}
