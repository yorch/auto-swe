'use client';

import { useMemo } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { repoRefLabel } from '@/lib/connectionDisplay';
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
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-[13px] font-medium text-paper-100">
          {group.toRef}
        </span>
        <Badge className="tabular shrink-0" tone="neutral" variant="outline">
          {group.repos.length} {group.repos.length === 1 ? 'repo' : 'repos'}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-400">
        <span>{group.repos.map(repoRefLabel).join(', ')}</span>
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
  emptyText = 'No suggestions yet — run Re-scan dependencies to look for repositories to onboard.',
}: {
  suggestions: UnresolvedDependencySuggestion[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  emptyText?: string;
}) {
  const groups = useMemo(() => groupByToRef(suggestions ?? []), [suggestions]);

  if (isLoading) {
    return <LoadingState compact message="Loading onboarding suggestions…" />;
  }

  if (isError) {
    return <Alert>{errMsg(error, 'Could not load onboarding suggestions.')}</Alert>;
  }

  if (groups.length === 0) {
    return <EmptyState bordered className="py-8" icon="repositories" title={emptyText} />;
  }

  return (
    <section className="space-y-3">
      <p className="text-paper-400 text-[13px]">
        Dependencies detected in manifests or git signals that don't resolve to an onboarded
        repository yet, grouped by the unresolved reference and ranked by how many repos declare it.
      </p>
      <ul className="divide-y divide-ink-600 overflow-hidden rounded-xl border border-ink-400/60 bg-ink-800/40">
        {groups.map((group) => (
          <SuggestionRow group={group} key={group.toRef} />
        ))}
      </ul>
    </section>
  );
}
