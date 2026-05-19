'use client';

import { useMemo, useState } from 'react';
import { LessonsByTypeChart } from '@/components/charts/LessonsByTypeChart';
import { LessonsOverTimeChart } from '@/components/charts/LessonsOverTimeChart';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useLessonSearch, useLessons, useRepositories } from '@/hooks/useWorkflows';
import { groupLessonsByDate, groupLessonsByType } from '@/lib/chartUtils';
import { formatDate } from '@/lib/utils';

export default function LessonsPage() {
  const { data: lessons, isLoading } = useLessons();
  const { data: repos = [] } = useRepositories();
  const [query, setQuery] = useState('');
  const [repoId, setRepoId] = useState('');
  const searchEnabled = query.trim().length > 0 && !!repoId;
  const { data: searchResults, isFetching: searchLoading } = useLessonSearch(
    searchEnabled ? query.trim() : '',
    searchEnabled ? repoId : null
  );

  const all = lessons ?? [];
  const visible = searchEnabled ? (searchResults ?? []) : all;
  const typeData = useMemo(() => groupLessonsByType(all), [all]);
  const timeData = useMemo(() => groupLessonsByDate(all), [all]);

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Agent Lessons</h2>

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Lessons by Failure Type</CardTitle>
          </CardHeader>
          <LessonsByTypeChart data={typeData} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lessons Over Time</CardTitle>
          </CardHeader>
          <LessonsOverTimeChart data={timeData} />
        </Card>
      </div>

      {/* Search bar — text + repo are both required by the API */}
      <Card variant="inset">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_240px]">
          <Input
            label="Search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. retry, timeout, race condition"
            value={query}
          />
          <div className="space-y-1.5">
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
              htmlFor="lesson-repo"
            >
              Repository
            </label>
            <select
              className="h-10 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 text-sm text-paper-100 outline-none focus:border-ember-400"
              id="lesson-repo"
              onChange={(e) => setRepoId(e.target.value)}
              value={repoId}
            >
              <option value="">All repos (no search)</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.organizationName}/{r.repoName}
                </option>
              ))}
            </select>
          </div>
        </div>
        {searchEnabled && (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
            {searchLoading
              ? 'Searching…'
              : `${visible.length} match${visible.length === 1 ? '' : 'es'} for "${query.trim()}"`}
          </p>
        )}
      </Card>

      <div className="space-y-4">
        {visible.map((l) => (
          <Card key={l.id}>
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="font-medium text-sm">{l.lessonSummary}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">{l.rationale}</p>
              </div>
              {l.failureType && (
                <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded-full ml-4">
                  {l.failureType.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-[var(--muted-foreground)]">
              <span>
                {l.repository?.organizationName}/{l.repository?.repoName}
              </span>
              <span>{formatDate(l.createdAt)}</span>
            </div>
          </Card>
        ))}
        {visible.length === 0 && (
          <p className="text-center text-[var(--muted-foreground)] py-12">
            {searchEnabled ? 'No matches.' : 'No lessons recorded yet'}
          </p>
        )}
      </div>
    </div>
  );
}
